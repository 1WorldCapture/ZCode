import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBridgeLock } from "../src/raft-agents/adapters/bridgeLock.js";
import {
  createBridgeSupervisor,
  redactSecrets,
} from "../src/raft-agents/adapters/bridgeSupervisor.js";
import type {
  BridgeExitInfo,
  OwnerGuardPort,
  WakeEndpointPort,
} from "../src/raft-agents/app/bridgePorts.js";

const TOKEN = "wake-token-secret-123";
const BINDING = {
  bindingId: "11111111-2222-3333-4444-555555555555",
  profileSlug: "raft-test",
  raftAgentId: "agent-1",
};

interface FakeMode {
  /** 启动后多久退出（毫秒）；缺省常驻。 */
  exitAfterMs?: number;
  exitCode?: number;
  /** 忽略 SIGTERM，测试强杀。 */
  ignoreSigterm?: boolean;
}

/** 假 bridge：记录 argv 与 env，向 stderr 输出含 token 的内容，再按模式退出。 */
async function makeFakeBridge(dir: string, mode: FakeMode) {
  const script = join(dir, "fake-bridge.mjs");
  await writeFile(join(dir, "mode.json"), JSON.stringify(mode));
  await writeFile(
    script,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const mode = JSON.parse(readFileSync(join(dir, "mode.json"), "utf8"));
writeFileSync(join(dir, "record.json"), JSON.stringify({ argv: process.argv.slice(2), token: process.env.RAFT_CHANNEL_TOKEN, profileDir: process.env.RAFT_PROFILE_DIR, envKeys: Object.keys(process.env) }));
process.stderr.write("boom token=" + process.env.RAFT_CHANNEL_TOKEN + " key=sk_agent_abc123\\n");
if (mode.ignoreSigterm) process.on("SIGTERM", () => {});
if (mode.exitAfterMs !== undefined) setTimeout(() => process.exit(mode.exitCode ?? 1), mode.exitAfterMs);
else setInterval(() => {}, 1000);
`,
  );
  await chmod(script, 0o755);
  return {
    script,
    // 轮询而非立即读：负载高时 node 子进程启动可能超过 settle 窗口，record.json 尚未落盘。
    // record.json 同时是"假 bridge 已就绪（SIGTERM handler 已装）"的信号。
    record: async () => {
      for (let i = 0; i < 80; i += 1) {
        try {
          return JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as {
            argv: string[];
            token: string;
            profileDir: string;
            envKeys: string[];
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      throw new Error("fake bridge 未在 2 秒内写出 record.json");
    },
  };
}

function makeSupervisor(
  dir: string,
  overrides: { owner?: boolean; settleMs?: number; stopGraceMs?: number } = {},
) {
  const opened: string[] = [];
  const closed: string[] = [];
  const wakeEndpoint: WakeEndpointPort = {
    open: async (id, opts) => {
      opened.push(`${id}:${opts.expectedAgentId}`);
      return { url: `http://127.0.0.1:1/${id}/wake`, token: TOKEN };
    },
    close: async (id) => {
      closed.push(id);
    },
  };
  const ownerGuard: OwnerGuardPort = { isOwner: () => overrides.owner ?? true };
  const supervisor = createBridgeSupervisor({
    dataRootDir: dir,
    wakeEndpoint,
    ownerGuard,
    settleMs: overrides.settleMs ?? 300,
    stopGraceMs: overrides.stopGraceMs ?? 300,
  });
  return { supervisor, opened, closed };
}

test("redactSecrets：抹掉本次 token 与 sk_agent_ 形态", () => {
  assert.equal(redactSecrets(`a ${TOKEN} b sk_agent_XyZ-1 c`, TOKEN), "a *** b *** c");
});

test("start：固定身份 argv，token 只在环境变量里，stop 视为主动结束", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, {});
    const { supervisor, closed } = makeSupervisor(dir);
    const exits: BridgeExitInfo[] = [];
    supervisor.onExit((info) => exits.push(info));
    const result = await supervisor.start(BINDING, fake.script);
    assert.equal(result.ok, true);
    assert.equal(supervisor.isRunning(BINDING.bindingId), true);
    const record = await fake.record();
    assert.deepEqual(record.argv, [
      "--profile",
      "raft-test",
      "agent",
      "bridge",
      "--expected-agent=agent-1",
      `--adapter-instance=${BINDING.bindingId}`,
      "--wake-adapter=wake-channel",
      `--wake-channel-endpoint=http://127.0.0.1:1/${BINDING.bindingId}/wake`,
      // 显式 activity 端点（保留 /<bindingId>/ 前缀）：bridge 默认派生会丢掉前缀导致 404。
      `--activity-channel-endpoint=http://127.0.0.1:1/${BINDING.bindingId}/activity/drain`,
      "--json",
    ]);
    assert.ok(!record.argv.join(" ").includes(TOKEN), "token 不得出现在 argv");
    assert.equal(record.token, TOKEN);
    assert.equal(record.profileDir, join(dir, "raft", "profiles", "raft-test"));
    await supervisor.stop(BINDING.bindingId);
    assert.equal(supervisor.isRunning(BINDING.bindingId), false);
    assert.deepEqual(closed, [BINDING.bindingId]);
    assert.deepEqual(exits, [], "主动停止不通知为故障");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start：启动期立即退出返回 EarlyExit，stderr 已脱敏，不重复通知", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, { exitAfterMs: 20, exitCode: 2 });
    const { supervisor } = makeSupervisor(dir, { settleMs: 1500 });
    const exits: BridgeExitInfo[] = [];
    supervisor.onExit((info) => exits.push(info));
    const result = await supervisor.start(BINDING, fake.script);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "EarlyExit");
    const detail = result.ok === false ? (result.detail ?? "") : "";
    assert.ok(
      detail.includes("boom") && !detail.includes(TOKEN) && !detail.includes("sk_agent_abc123"),
    );
    assert.deepEqual(exits, []);
    assert.equal(supervisor.isRunning(BINDING.bindingId), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("意外退出：不自动重启，上报 requested=false 与脱敏 stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, { exitAfterMs: 700, exitCode: 3 });
    const { supervisor } = makeSupervisor(dir, { settleMs: 200 });
    const exited = new Promise<BridgeExitInfo>((resolve) => supervisor.onExit(resolve));
    assert.equal((await supervisor.start(BINDING, fake.script)).ok, true);
    const info = await exited;
    assert.equal(info.requested, false);
    assert.equal(info.code, 3);
    assert.ok(!info.stderrTail.includes(TOKEN) && info.stderrTail.includes("boom"));
    assert.equal(supervisor.isRunning(BINDING.bindingId), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("非主窗口拒绝启动；重复启动返回 AlreadyRunning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, {});
    const notOwner = makeSupervisor(dir, { owner: false });
    const denied = await notOwner.supervisor.start(BINDING, fake.script);
    assert.equal(denied.ok === false && denied.code, "NotOwner");
    assert.deepEqual(notOwner.opened, [], "非主窗口不得打开唤醒端点");

    const { supervisor } = makeSupervisor(dir);
    assert.equal((await supervisor.start(BINDING, fake.script)).ok, true);
    const again = await supervisor.start(BINDING, fake.script);
    assert.equal(again.ok === false && again.code, "AlreadyRunning");
    await supervisor.stopAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("跨进程锁：被存活进程持有时返回 LockHeld；持有者已退出的陈旧锁会被回收", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, {});
    // 本进程先持有锁，模拟「另一个存活的 ZCode 进程」（共享锁按 owner pid 存活判定）。
    const holder = createBridgeLock({ dataRootDir: dir });
    const held = await holder.acquire(BINDING.bindingId);
    assert.ok(held);
    const { supervisor } = makeSupervisor(dir);
    const blocked = await supervisor.start(BINDING, fake.script);
    assert.equal(blocked.ok === false && blocked.code, "LockHeld");
    await held.release();

    // 持有者已退出（陈旧锁：owner 文件里的 pid 不存在）：回收后可启动。
    const lockDir = join(dir, "raft", "locks", `${BINDING.bindingId}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner-dead.json"),
      JSON.stringify({ pid: 2147483646, createdAt: Date.now(), token: "dead" }),
    );
    const { supervisor: second } = makeSupervisor(dir);
    assert.equal((await second.start(BINDING, fake.script)).ok, true);
    await second.stopAll();
    // 释放后锁目录不残留。
    await assert.rejects(() => readdir(lockDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("跨进程锁：升级前遗留的单文件 pid 锁（持有者已退出）会被回收；非法 bindingId 拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    await mkdir(join(dir, "raft", "locks"), { recursive: true });
    await writeFile(join(dir, "raft", "locks", "abc.lock"), "2147483646");
    const lock = createBridgeLock({ dataRootDir: dir });
    const handle = await lock.acquire("abc");
    assert.ok(handle);
    await handle.release();
    await assert.rejects(() => lock.acquire("../evil"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopAll：忽略 SIGTERM 的进程在宽限期后被强杀", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, { ignoreSigterm: true });
    const { supervisor } = makeSupervisor(dir, { stopGraceMs: 300 });
    assert.equal((await supervisor.start(BINDING, fake.script)).ok, true);
    // 等 SIGTERM handler 就绪再停：否则 SIGTERM 落在 node 启动期（handler 未装）会立即退出，
    // "等满宽限期再强杀"的时序断言在慢机上必然偶发失败。
    await fake.record();
    const startedAt = Date.now();
    await supervisor.stopAll();
    assert.equal(supervisor.isRunning(BINDING.bindingId), false);
    assert.ok(Date.now() - startedAt >= 250, "应等满宽限期再强杀");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminateAllNow：同步强杀，随后清理完成并释放锁", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bridge-"));
  try {
    const fake = await makeFakeBridge(dir, { ignoreSigterm: true });
    const { supervisor, closed } = makeSupervisor(dir);
    const exits: BridgeExitInfo[] = [];
    supervisor.onExit((info) => exits.push(info));
    assert.equal((await supervisor.start(BINDING, fake.script)).ok, true);
    supervisor.terminateAllNow();
    for (let i = 0; i < 50 && supervisor.isRunning(BINDING.bindingId); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(supervisor.isRunning(BINDING.bindingId), false);
    assert.deepEqual(closed, [BINDING.bindingId]);
    assert.deepEqual(exits, [], "主动强杀不通知为故障");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
