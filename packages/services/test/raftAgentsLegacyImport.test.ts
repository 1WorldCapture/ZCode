/**
 * 存量 ZCode 绑定只读导入器测试（TinyCode 首启；PM 决定③ + grokbot 九条）。
 * 覆盖：detect 全分支（同根/缺源/源损坏零写入/无绑定/目标非空/已拒绝/非法 slug/
 * 值守中）、导入快照（默认与自定义 Home、mainSessionRef 清空、desiredState 两种
 * 语义、源侧停止写+备份+校验、权限保留、inbox-logs/profiles 复制）、失败回滚
 * （只清目标根、源侧停止写逐字节还原）、锁探测（目录锁活/死 pid、旧单文件锁）、
 * 启动门 legacy probe（ErrorPaused(legacy_watch_held) / 放行）、拒绝标记。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RaftAgentBinding } from "@zcode/shared";

import {
  createLegacyZCodeImporter,
  writeLegacyImportDeclinedMarker,
} from "../src/raft-agents/adapters/legacyImport.js";
import { LegacyImportError } from "../src/raft-agents/adapters/legacyImportCopy.js";
import {
  createLegacyWatchProbeFor,
  probeLegacyWatchHeld,
} from "../src/raft-agents/adapters/legacyWatchProbe.js";
import { createRaftBindingStore } from "../src/raft-agents/adapters/bindingStore.js";
import { runWatchStartGates } from "../src/raft-agents/app/watchStartGates.js";
import type { RaftBindingStorePort } from "../src/raft-agents/app/ports.js";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AGENT_A = "99999999-8888-4777-a666-555555555555";
const AGENT_B = "88888888-7777-4666-b555-444444444444";
const DEAD_PID = 999_999_999;

function makeBinding(overrides: Partial<RaftAgentBinding> = {}): RaftAgentBinding {
  return {
    bindingId: ID_A,
    displayName: "ta-1",
    raftOrigin: "https://raft.example.com",
    serverId: "srv-1",
    raftAgentId: AGENT_A,
    profileSlug: "raft-111111112222",
    homeWorkspacePath: "", // by fixture
    mainSessionRef: { sessionId: "sess-1", sessionGeneration: 3 },
    desiredState: "Running",
    autostartConsent: false,
    adapterInstance: ID_A,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

async function makeTempRoots() {
  const base = join(tmpdir(), `raft-legacy-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourceRootDir = join(base, ".zcode");
  const targetRootDir = join(base, ".tinycode");
  return { base, sourceRootDir, targetRootDir };
}

/** 构造一份完整的源产品数据根：bindings + profiles + 默认 Home + inbox-logs。 */
async function seedSource(
  sourceRootDir: string,
  overrides: { bindings?: RaftAgentBinding[] } = {},
): Promise<{ bindings: RaftAgentBinding[]; originalJson: string }> {
  const bindingA = makeBinding({
    homeWorkspacePath: join(sourceRootDir, "agents", ID_A, "workspace"),
  });
  const bindingB = makeBinding({
    bindingId: ID_B,
    raftAgentId: AGENT_B,
    displayName: "ta-2",
    profileSlug: "raft-aaaaaaaabbbb",
    homeWorkspacePath: join(sourceRootDir, "Users", "proj", "custom-home"),
    desiredState: "ReadyStopped",
  });
  const bindings = overrides.bindings ?? [bindingA, bindingB];
  const originalJson = `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`;
  await mkdir(join(sourceRootDir, "raft", "profiles"), { recursive: true });
  await writeFile(join(sourceRootDir, "raft", "bindings.json"), originalJson);
  for (const slug of ["raft-111111112222", "raft-aaaaaaaabbbb"]) {
    const dir = join(sourceRootDir, "raft", "profiles", slug);
    await mkdir(join(dir, "agent-comms-core", "deadbeef-0000-4000-8000-000000000000"), {
      recursive: true,
    });
    await writeFile(join(dir, "credential.json"), `{"apiKey":"sk_agent_secret_${slug}"}`, {
      mode: 0o600,
    });
    await writeFile(
      join(dir, "agent-comms-core", "deadbeef-0000-4000-8000-000000000000", "state.json"),
      "{}\n",
    );
  }
  // 默认 Home A：记忆面 + 归属标记（内容 = bindingId）。
  const homeA = join(sourceRootDir, "agents", ID_A, "workspace");
  await mkdir(join(homeA, "notes"), { recursive: true });
  await writeFile(join(homeA, "MEMORY.md"), "# ta-1 memory\n", { mode: 0o600 });
  await writeFile(join(homeA, "AGENTS.md"), "# ta-1\n", { mode: 0o600 });
  await writeFile(join(homeA, "notes", "work.md"), "- did things\n");
  await writeFile(join(homeA, ".zcode-agent-home"), `${ID_A}\n`);
  // 自定义 Home B：源侧同样创建（但 default/custom 判定按路径，不复制）。
  const homeB = join(sourceRootDir, "Users", "proj", "custom-home");
  await mkdir(homeB, { recursive: true });
  await writeFile(join(homeB, "MEMORY.md"), "# ta-2 memory\n");
  // inbox-logs：A 有、B 无（缺 = 正常）。
  await mkdir(join(sourceRootDir, "raft", "inbox-logs", ID_A), { recursive: true });
  await writeFile(join(sourceRootDir, "raft", "inbox-logs", ID_A, "wake-1.json"), "{}\n");
  return { bindings, originalJson };
}

async function writeLiveLock(sourceRootDir: string, bindingId: string, pid = process.pid) {
  const lockDir = join(sourceRootDir, "raft", "locks", `${bindingId}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, `owner-${pid}-${Date.now()}.json`),
    `${JSON.stringify({ pid, createdAt: Date.now(), token: "t" })}\n`,
  );
}

test("detect: same-root / source-missing / no-bindings / target-not-empty", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });

  const same = createLegacyZCodeImporter({ sourceRootDir, targetRootDir: sourceRootDir });
  assert.deepEqual(await same.detect(), { status: "not-available", reason: "same-root" });

  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "source-missing" });

  await mkdir(join(sourceRootDir, "raft"), { recursive: true });
  await writeFile(join(sourceRootDir, "raft", "bindings.json"), `{"version":1,"bindings":[]}\n`);
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "no-bindings" });

  await seedSource(sourceRootDir);
  const store = createRaftBindingStore(targetRootDir);
  await store.writeAll([makeBinding({ homeWorkspacePath: "/tmp/x" })]);
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "target-not-empty" });
});

test("detect: 源损坏 fail-closed 且零写入（无备份文件、无锁目录残留）", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  await mkdir(join(sourceRootDir, "raft"), { recursive: true });
  await writeFile(join(sourceRootDir, "raft", "bindings.json"), "{ not json");
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "source-corrupt" });
  // 关键：损坏处理绝不像 bindingStore 那样写 backupCorruptFile（那是 ZCode 自己的语义）。
  const raftEntries = await readdir(join(sourceRootDir, "raft"));
  assert.deepEqual(raftEntries, ["bindings.json"]);
  await assert.rejects(
    () => importer.importBindings({ stopLegacyBindings: true }),
    (error: unknown) => error instanceof LegacyImportError && error.code === "not-available",
  );
});

test("detect: 非法 profileSlug / 值守中 / 已拒绝标记", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { bindings } = await seedSource(sourceRootDir);
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });

  // 非法 slug（schema 允许 min(1)，安全白名单不允许——导入侧必须再拦一道）。
  const badSlug = makeBinding({ ...bindings[0]!, profileSlug: "../escape" });
  const badStore = createRaftBindingStore(sourceRootDir);
  await badStore.writeAll([badSlug, bindings[1]!]);
  const badDetect = await importer.detect();
  assert.equal(badDetect.status, "not-available");
  assert.equal(badDetect.reason, "invalid-binding");
  await badStore.writeAll(bindings);

  // 值守中：活 pid 持锁 → 拒绝。
  await writeLiveLock(sourceRootDir, ID_A);
  const heldDetect = await importer.detect();
  assert.equal(heldDetect.status, "not-available");
  assert.equal(heldDetect.reason, "legacy-watch-held");
  assert.ok(heldDetect.detail?.includes(ID_A));

  // 陈旧锁（死 pid）不阻塞：先清掉活锁，再只留死 owner。
  await rm(join(sourceRootDir, "raft", "locks", `${ID_A}.lock`), { recursive: true, force: true });
  await writeLiveLock(sourceRootDir, ID_A, DEAD_PID);
  const staleDetect = await importer.detect();
  assert.equal(staleDetect.status, "available");

  // 拒绝标记：一次拒绝后不再提供。
  await writeLegacyImportDeclinedMarker(targetRootDir, () => new Date("2026-10-02T00:00:00Z"));
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "already-declined" });
});

test("导入（勾选停止）：复制+改写+源侧停止写+备份，源其余数据原样", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { bindings, originalJson } = await seedSource(sourceRootDir);
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });

  const result = await importer.importBindings({ stopLegacyBindings: true });
  assert.equal(result.importedCount, 2);
  assert.equal(result.stoppedInLegacy, true);
  assert.ok(result.backupPath?.includes("bindings.json.pre-tinycode-import-"));

  // 目标：bindings 全量、Home 改写到目标根、会话引用清空、desiredState 保留。
  const target = await createRaftBindingStore(targetRootDir).readAll();
  assert.equal(target.length, 2);
  const targetA = target.find((b) => b.bindingId === ID_A)!;
  const targetB = target.find((b) => b.bindingId === ID_B)!;
  assert.equal(targetA.homeWorkspacePath, join(targetRootDir, "agents", ID_A, "workspace"));
  assert.equal(targetA.mainSessionRef, null);
  assert.equal(targetA.desiredState, "Running");
  assert.equal(targetB.homeWorkspacePath, join(sourceRootDir, "Users", "proj", "custom-home"));
  assert.equal(targetB.desiredState, "ReadyStopped");

  // 目标：profiles（保 0600）、默认 Home（记忆 + 归属标记原内容）、inbox-logs。
  const cred = join(targetRootDir, "raft", "profiles", "raft-111111112222", "credential.json");
  assert.equal((await readFile(cred, "utf8")).includes("sk_agent_secret_"), true);
  assert.equal(statSync(cred).mode & 0o777, 0o600);
  assert.equal(
    await readFile(join(targetRootDir, "agents", ID_A, "workspace", ".zcode-agent-home"), "utf8"),
    `${ID_A}\n`,
  );
  assert.ok(existsSync(join(targetRootDir, "agents", ID_A, "workspace", "notes", "work.md")));
  assert.ok(existsSync(join(targetRootDir, "raft", "inbox-logs", ID_A, "wake-1.json")));
  // 自定义 Home 不复制。
  assert.equal(existsSync(join(targetRootDir, "agents", ID_B)), false);

  // 源：停止写生效 + 备份逐字节等于原文 + 其余数据未动。
  const sourceAfter = await createRaftBindingStore(sourceRootDir).readAll();
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_A)!.desiredState, "ReadyStopped");
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_B)!.desiredState, "ReadyStopped");
  assert.equal(await readFile(result.backupPath!, "utf8"), originalJson);
  assert.ok(existsSync(join(sourceRootDir, "raft", "profiles", "raft-111111112222", "credential.json")));
  assert.ok(existsSync(join(sourceRootDir, "agents", ID_A, "workspace", "MEMORY.md")));
  // 锁目录不迁移。
  assert.equal(existsSync(join(targetRootDir, "raft", "locks")), false);
});

test("导入（未勾选停止）：目标一律置停止，源 bindings.json 逐字节不变", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { originalJson } = await seedSource(sourceRootDir);
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });

  const result = await importer.importBindings({ stopLegacyBindings: false });
  assert.equal(result.stoppedInLegacy, false);
  assert.equal(result.backupPath, undefined);
  assert.equal(await readFile(join(sourceRootDir, "raft", "bindings.json"), "utf8"), originalJson);
  const target = await createRaftBindingStore(targetRootDir).readAll();
  assert.ok(target.every((b) => b.desiredState === "ReadyStopped"));
});

test("失败回滚：源侧 Home 内符号链接 → 只清目标根半成品，源数据原样", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  await seedSource(sourceRootDir);
  // 默认 Home 里放一个符号链接：复制必拒（grokbot 第 5 条）。
  await symlink(
    join(sourceRootDir, "raft", "profiles", "raft-111111112222", "credential.json"),
    join(sourceRootDir, "agents", ID_A, "workspace", "notes", "link.md"),
  );
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });

  await assert.rejects(
    () => importer.importBindings({ stopLegacyBindings: true }),
    (error: unknown) => error instanceof LegacyImportError && error.code === "symlink-refused",
  );
  // 目标根：无 bindings.json；复制过的 profiles 半成品被清（回滚红线：只清新根）。
  assert.equal(existsSync(join(targetRootDir, "raft", "bindings.json")), false);
  assert.equal(existsSync(join(targetRootDir, "raft", "profiles", "raft-111111112222", "credential.json")), false);
  // 源：未做停止写（失败发生在步骤 2），全部原样。
  const sourceAfter = await createRaftBindingStore(sourceRootDir).readAll();
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_A)!.desiredState, "Running");
});

test("锁探测：目录锁活 pid=held、死 pid=不 held；旧单文件锁两种形态", async () => {
  const { sourceRootDir } = await makeTempRoots();

  await writeLiveLock(sourceRootDir, ID_A);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A), true);
  await writeLiveLock(sourceRootDir, ID_B, DEAD_PID);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_B), false);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, "no-such-binding"), false);
  // 非法 bindingId 不拼路径。
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, "../../etc"), false);

  // 旧单文件锁：JSON 与裸数字两种内容形态都认活 pid。
  await mkdir(join(sourceRootDir, "raft", "locks"), { recursive: true });
  await writeFile(
    join(sourceRootDir, "raft", "locks", "json.lock"),
    `${JSON.stringify({ pid: process.pid })}\n`,
  );
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, "json"), true);
  await writeFile(join(sourceRootDir, "raft", "locks", "bare.lock"), `${process.pid}\n`);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, "bare"), true);
});

test("启动门：旧侧持锁 → ErrorPaused(legacy_watch_held)；未持锁 → 放行", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  await seedSource(sourceRootDir);
  const binding = makeBinding({ homeWorkspacePath: join(targetRootDir, "agents", ID_A, "workspace") });
  const store: RaftBindingStorePort = {
    async readAll() {
      return [binding];
    },
    async writeAll() {},
  };
  const baseDeps = {
    cli: { resolve: async () => ({ ok: true as const, cliPath: "/fake/raft", version: "0.0.24" }) },
    memory: {
      verifyMemoryAvailable: async () => ({ ok: true as const }),
    },
    store,
    resolveOfficialMcpServers: async () => [
      { name: "raft-agent-tools", env: [{ name: "ZCODE_RAFT_BINDING_ID", value: ID_A }] },
    ],
  };

  const blocked = await runWatchStartGates(
    { ...baseDeps, legacyWatchProbe: { isWatchHeld: async () => true } },
    ID_A,
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok && blocked.failure.code === "LegacyWatchHeld") {
    assert.equal(blocked.failure.reason, "legacy_watch_held");
  } else {
    assert.fail("expected LegacyWatchHeld failure");
  }

  // probe 抛错 fail-open（旧根缺失是常态）。
  const failOpen = await runWatchStartGates(
    {
      ...baseDeps,
      legacyWatchProbe: {
        isWatchHeld: async () => {
          throw new Error("boom");
        },
      },
    },
    ID_A,
  );
  assert.equal(failOpen.ok, true);

  const allowed = await runWatchStartGates(
    { ...baseDeps, legacyWatchProbe: { isWatchHeld: async () => false } },
    ID_A,
  );
  assert.equal(allowed.ok, true);

  // 未注入（同产品形态）：行为与放行一致。
  const noProbe = await runWatchStartGates(baseDeps, ID_A);
  assert.equal(noProbe.ok, true);
});

test("createLegacyWatchProbeFor：同根名 → undefined（同产品无旧侧）", async () => {
  // ZCODE_DATA_ROOT_NAME 在 services 测试运行时为 fallback ".zcode"（无 define 注入），
  // 与 LEGACY 同名 → undefined；TinyCode 构建期为 ".tinycode" → probe 指向同 base 的 .zcode。
  const probe = createLegacyWatchProbeFor(join(tmpdir(), "base", ".tinycode"));
  if (probe === undefined) {
    assert.equal(probe, undefined);
  } else {
    assert.ok(probe.legacyRootDir.endsWith(".zcode"));
    assert.equal(typeof probe.isWatchHeld, "function");
  }
});

test("declined 标记：0600、内容 ISO 时间戳", async () => {
  const { targetRootDir } = await makeTempRoots();
  await writeLegacyImportDeclinedMarker(targetRootDir, () => new Date("2026-10-02T08:00:00Z"));
  const marker = join(targetRootDir, "raft", "legacy-import-declined");
  assert.equal(await readFile(marker, "utf8"), "2026-10-02T08:00:00.000Z\n");
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  // 幂等拒绝：第二次导入尝试直接 not-available（wx 撞已有文件会被 detect 先拦）。
  const importer = createLegacyZCodeImporter({
    sourceRootDir: join(targetRootDir, "no-source"),
    targetRootDir,
  });
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "already-declined" });
});
