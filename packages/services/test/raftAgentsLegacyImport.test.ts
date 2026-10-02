// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 存量 ZCode 绑定只读导入器测试（TinyCode 首启；PM 决定③ + grokbot 九条/复核七条）。
 * 覆盖：detect 全分支（同根/缺源/源损坏零写入/无绑定/目标非空/已拒绝/非法 slug/
 * 值守中/ZCode 主进程运行中/坏锁 fail-closed/全部归属不明）、Home 分类（容器
 * UUID≠bindingId 的默认 Home 复制+改写+标记匹配 / 标记不符拒绝 / 真 custom 不复制）、
 * 导入快照（mainSessionRef 清空、desiredState 两种语义、源侧停止写+备份+深比较校验、
 * 权限保留、inbox-logs/profiles 复制）、失败回滚（符号链接；停止写成功后提交失败 →
 * 源逐字节还原）、停止写写前再探（进程/锁）、SingletonLock 探测、启动门、拒绝标记。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import type { RaftAgentBinding } from "@zcode/shared";

import {
  createLegacyZCodeImporter,
  writeLegacyImportDeclinedMarker,
  type LegacyZCodeImporterOptions,
} from "../src/raft-agents/adapters/legacyImport.js";
import { LegacyImportError } from "../src/raft-agents/adapters/legacyImportCopy.js";
import { stopLegacyWatch } from "../src/raft-agents/adapters/legacyImportStop.js";
import {
  createLegacyWatchProbeFor,
  probeLegacyWatchHeld,
  probeLegacyZCodeAppRunning,
} from "../src/raft-agents/adapters/legacyWatchProbe.js";
import { resolveAgentHomeKind } from "../src/raft-agents/adapters/agentHomeKind.js";
import { createRaftBindingStore } from "../src/raft-agents/adapters/bindingStore.js";
import { runWatchStartGates } from "../src/raft-agents/app/watchStartGates.js";
import type { RaftBindingStorePort } from "../src/raft-agents/app/ports.js";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ID_C = "cccccccc-dddd-4eee-8fff-000000000000";
const AGENT_A = "99999999-8888-4777-a666-555555555555";
const AGENT_B = "88888888-7777-4666-b555-444444444444";
const AGENT_C = "77777777-6666-4555-a444-333333333333";
// 默认 Home 容器名是预派发 UUID，故意 ≠ bindingId（PM 修法四条的真实形态）。
const CONTAINER_A = "5bacbaf8-1234-4abc-9def-aabbccddeeff";
const CONTAINER_C = "11111111-aaaa-4bbb-8ccc-222222222222";
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

/** 统一注入「ZCode 主进程未运行」，隔离宿主机上真跑着 ZCode 的环境。 */
function makeImporter(
  sourceRootDir: string,
  targetRootDir: string,
  extra: Partial<LegacyZCodeImporterOptions> = {},
) {
  return createLegacyZCodeImporter({
    sourceRootDir,
    targetRootDir,
    probeLegacyAppRunning: async () => false,
    ...extra,
  });
}

/** 构造一份完整的源产品数据根：bindings + profiles + 默认 Home（容器 UUID）+ inbox-logs。 */
async function seedSource(
  sourceRootDir: string,
  overrides: { bindings?: RaftAgentBinding[]; includeC?: boolean } = {},
): Promise<{ bindings: RaftAgentBinding[]; originalJson: string }> {
  const defaultHomeA = join(sourceRootDir, "agents", CONTAINER_A, "workspace");
  const bindingA = makeBinding({ homeWorkspacePath: defaultHomeA });
  const bindingB = makeBinding({
    bindingId: ID_B,
    raftAgentId: AGENT_B,
    displayName: "ta-2",
    profileSlug: "raft-aaaaaaaabbbb",
    homeWorkspacePath: join(sourceRootDir, "Users", "proj", "custom-home"),
    desiredState: "ReadyStopped",
  });
  const bindingC = makeBinding({
    bindingId: ID_C,
    raftAgentId: AGENT_C,
    displayName: "ta-3",
    profileSlug: "raft-ccccccccdddd",
    homeWorkspacePath: join(sourceRootDir, "agents", CONTAINER_C, "workspace"),
  });
  const bindings = overrides.bindings ?? (overrides.includeC ? [bindingA, bindingB, bindingC] : [bindingA, bindingB]);
  const originalJson = `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`;
  await mkdir(join(sourceRootDir, "raft", "profiles"), { recursive: true });
  await writeFile(join(sourceRootDir, "raft", "bindings.json"), originalJson);
  for (const slug of ["raft-111111112222", "raft-aaaaaaaabbbb", "raft-ccccccccdddd"]) {
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
  // 默认 Home A（容器 UUID ≠ bindingId）：记忆面 + 归属标记（内容 = bindingId）。
  const homeA = defaultHomeA;
  await mkdir(join(homeA, "notes"), { recursive: true });
  await writeFile(join(homeA, "MEMORY.md"), "# ta-1 memory\n", { mode: 0o600 });
  await writeFile(join(homeA, "AGENTS.md"), "# ta-1\n", { mode: 0o600 });
  await writeFile(join(homeA, "notes", "work.md"), "- did things\n");
  await writeFile(join(homeA, ".zcode-agent-home"), `${ID_A}\n`);
  // 自定义 Home B：源侧同样创建（custom 判定按路径，不复制）。
  const homeB = join(sourceRootDir, "Users", "proj", "custom-home");
  await mkdir(homeB, { recursive: true });
  await writeFile(join(homeB, "MEMORY.md"), "# ta-2 memory\n");
  // 绑定 C 的 Home：容器在 agents/ 下但归属标记写的是 A 的 id（归属不明场景）。
  const homeC = join(sourceRootDir, "agents", CONTAINER_C, "workspace");
  await mkdir(homeC, { recursive: true });
  await writeFile(join(homeC, ".zcode-agent-home"), `${ID_A}\n`);
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
  const importer = makeImporter(sourceRootDir, targetRootDir);

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
  const importer = makeImporter(sourceRootDir, targetRootDir);
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "source-corrupt" });
  // 关键：损坏处理绝不像 bindingStore 那样写 backupCorruptFile（那是 ZCode 自己的语义）。
  const raftEntries = await readdir(join(sourceRootDir, "raft"));
  assert.deepEqual(raftEntries, ["bindings.json"]);
  await assert.rejects(
    () => importer.importBindings({ stopLegacyBindings: true }),
    (error: unknown) => error instanceof LegacyImportError && error.code === "not-available",
  );
});

test("detect: 非法 profileSlug / 值守中 / 已拒绝标记 / ZCode 主进程运行中", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { bindings } = await seedSource(sourceRootDir);
  const importer = makeImporter(sourceRootDir, targetRootDir);

  // 非法 slug（schema 允许 min(1)，安全白名单不允许——导入侧必须再拦一道）。
  const badSlug = makeBinding({ ...bindings[0]!, profileSlug: "../escape" });
  const badStore = createRaftBindingStore(sourceRootDir);
  await badStore.writeAll([badSlug, bindings[1]!]);
  const badDetect = await importer.detect();
  assert.equal(badDetect.status, "not-available");
  assert.equal(badDetect.reason, "invalid-binding");
  await badStore.writeAll(bindings);

  // ZCode 主进程运行中（grokbot 复核 1）→ 拒绝且不写任何东西。
  const runningImporter = makeImporter(sourceRootDir, targetRootDir, {
    probeLegacyAppRunning: async () => true,
  });
  assert.deepEqual(await runningImporter.detect(), { status: "not-available", reason: "legacy-app-running" });
  assert.equal(existsSync(join(targetRootDir, "raft")), false);

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

test("detect: 坏 owner 锁按 held 拒绝（detect fail-closed）；直探默认 fail-open", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { bindings } = await seedSource(sourceRootDir);
  const importer = makeImporter(sourceRootDir, targetRootDir);

  // owner 文件存在但内容不是 JSON：detect 面按持有拒绝（grokbot 复核 5）。
  const lockDir = join(sourceRootDir, "raft", "locks", `${ID_A}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner-broken.json"), "not json");
  const badDetect = await importer.detect();
  assert.equal(badDetect.status, "not-available");
  assert.equal(badDetect.reason, "legacy-watch-held");
  // 启动门口径（不传 opts）：fail-open，不阻塞。
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A), false);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A, { unparsableAsHeld: true }), true);

  // 空锁目录（创建者崩溃未写 owner）：detect 面 held、启动门 fail-open。
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir, { recursive: true });
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A), false);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A, { unparsableAsHeld: true }), true);

  // 干净的死 pid owner：能证明已死 → 两种口径都不阻塞。
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, `owner-${DEAD_PID}-0.json`),
    `${JSON.stringify({ pid: DEAD_PID })}\n`,
  );
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A), false);
  assert.equal(await probeLegacyWatchHeld(sourceRootDir, ID_A, { unparsableAsHeld: true }), false);
  void bindings;
});

test("导入（勾选停止）：容器 UUID≠bindingId 的 Home 复制+改写+标记匹配；源停止写+备份", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { bindings, originalJson } = await seedSource(sourceRootDir);
  const importer = makeImporter(sourceRootDir, targetRootDir);

  const detect = await importer.detect();
  assert.equal(detect.status, "available");
  if (detect.status === "available") {
    assert.equal(detect.preview.bindings.find((b) => b.bindingId === ID_A)!.homeKind, "default");
    assert.equal(detect.preview.bindings.find((b) => b.bindingId === ID_B)!.homeKind, "custom");
    assert.deepEqual(detect.preview.skipped, []);
  }

  const result = await importer.importBindings({ stopLegacyBindings: true });
  assert.equal(result.importedCount, 2);
  assert.equal(result.stoppedInLegacy, true);
  assert.deepEqual(result.skippedHomeBindings, []);
  assert.ok(result.backupPath?.includes("bindings.json.pre-tinycode-import-"));

  // 目标：Home 沿用原容器名（UUID），标记内容仍匹配 bindingId。
  const target = await createRaftBindingStore(targetRootDir).readAll();
  assert.equal(target.length, 2);
  const targetA = target.find((b) => b.bindingId === ID_A)!;
  const targetB = target.find((b) => b.bindingId === ID_B)!;
  assert.equal(targetA.homeWorkspacePath, join(targetRootDir, "agents", CONTAINER_A, "workspace"));
  assert.equal(targetA.mainSessionRef, null);
  assert.equal(targetA.desiredState, "Running");
  assert.equal(targetB.homeWorkspacePath, join(sourceRootDir, "Users", "proj", "custom-home"));
  assert.equal(targetB.desiredState, "ReadyStopped");
  assert.equal(
    await readFile(join(targetRootDir, "agents", CONTAINER_A, "workspace", ".zcode-agent-home"), "utf8"),
    `${ID_A}\n`,
  );

  // 目标：profiles（保 0600）、默认 Home（记忆 + 归属标记原内容）、inbox-logs。
  const cred = join(targetRootDir, "raft", "profiles", "raft-111111112222", "credential.json");
  assert.equal((await readFile(cred, "utf8")).includes("sk_agent_secret_"), true);
  assert.equal(statSync(cred).mode & 0o777, 0o600);
  assert.ok(existsSync(join(targetRootDir, "agents", CONTAINER_A, "workspace", "notes", "work.md")));
  assert.ok(existsSync(join(targetRootDir, "raft", "inbox-logs", ID_A, "wake-1.json")));
  // 自定义 Home 不复制。
  assert.equal(existsSync(join(targetRootDir, "agents", ID_B)), false);

  // 源：停止写生效 + 备份逐字节等于原文 + 其余数据未动。
  const sourceAfter = await createRaftBindingStore(sourceRootDir).readAll();
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_A)!.desiredState, "ReadyStopped");
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_B)!.desiredState, "ReadyStopped");
  assert.equal(await readFile(result.backupPath!, "utf8"), originalJson);
  assert.ok(existsSync(join(sourceRootDir, "raft", "profiles", "raft-111111112222", "credential.json")));
  assert.ok(existsSync(join(sourceRootDir, "agents", CONTAINER_A, "workspace", "MEMORY.md")));
  // 锁目录不迁移。
  assert.equal(existsSync(join(targetRootDir, "raft", "locks")), false);
  void bindings;
});

test("导入（未勾选停止）：目标一律置停止，源 bindings.json 逐字节不变", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { originalJson } = await seedSource(sourceRootDir);
  const importer = makeImporter(sourceRootDir, targetRootDir);

  const result = await importer.importBindings({ stopLegacyBindings: false });
  assert.equal(result.stoppedInLegacy, false);
  assert.equal(result.backupPath, undefined);
  assert.equal(await readFile(join(sourceRootDir, "raft", "bindings.json"), "utf8"), originalJson);
  const target = await createRaftBindingStore(targetRootDir).readAll();
  assert.ok(target.every((b) => b.desiredState === "ReadyStopped"));
});

test("归属不明（marker 不匹配）：预览标出+跳过该绑定；全部不明 → all-unknown-home", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { bindings } = await seedSource(sourceRootDir, { includeC: true });
  const importer = makeImporter(sourceRootDir, targetRootDir);

  const detect = await importer.detect();
  assert.equal(detect.status, "available");
  if (detect.status === "available") {
    assert.deepEqual(
      detect.preview.skipped.map((s) => s.bindingId),
      [ID_C],
    );
    assert.equal(detect.preview.skipped[0]!.reason, "unknown-home");
  }

  const result = await importer.importBindings({ stopLegacyBindings: true });
  assert.equal(result.importedCount, 2);
  assert.deepEqual(
    result.skippedHomeBindings.map((s) => s.bindingId),
    [ID_C],
  );
  // 目标无 C 的任何痕迹；源侧 C 未被停止写（不导入即不动）。
  assert.equal(existsSync(join(targetRootDir, "agents", CONTAINER_C)), false);
  const sourceAfter = await createRaftBindingStore(sourceRootDir).readAll();
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_C)!.desiredState, "Running");
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_A)!.desiredState, "ReadyStopped");

  // 全部归属不明 → 整体 not-available。
  const { sourceRootDir: src2, targetRootDir: tgt2 } = await makeTempRoots();
  const { bindings: b2 } = await seedSource(src2, { includeC: true });
  // 让 C 容器的 marker 对 A、C 都不匹配（写成第三个绑定的 id）。
  await writeFile(join(src2, "agents", CONTAINER_C, "workspace", ".zcode-agent-home"), `${ID_B}\n`);
  const store2 = createRaftBindingStore(src2);
  await store2.writeAll([b2.find((b) => b.bindingId === ID_C)!, makeBinding({
    bindingId: ID_A,
    raftAgentId: AGENT_A,
    profileSlug: "raft-111111112222",
    homeWorkspacePath: join(src2, "agents", CONTAINER_C, "workspace"), // 同一不明容器
  })]);
  const detect2 = await makeImporter(src2, tgt2).detect();
  assert.equal(detect2.status, "not-available");
  assert.equal(detect2.reason, "all-unknown-home");
  assert.ok(detect2.detail?.includes(ID_C));
  void bindings;
});

test("失败回滚：源侧 Home 内符号链接 → 只清目标根半成品，源数据原样", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  await seedSource(sourceRootDir);
  // 默认 Home 里放一个符号链接：复制必拒（grokbot 第 5 条）。
  await symlink(
    join(sourceRootDir, "raft", "profiles", "raft-111111112222", "credential.json"),
    join(sourceRootDir, "agents", CONTAINER_A, "workspace", "notes", "link.md"),
  );
  const importer = makeImporter(sourceRootDir, targetRootDir);

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

test("失败回滚：停止写成功后目标提交失败 → 源逐字节还原、备份保留（grokbot 复核 4）", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  const { originalJson } = await seedSource(sourceRootDir);
  const importer = makeImporter(sourceRootDir, targetRootDir, {
    createBindingStore: () => ({
      async readAll() {
        return [];
      },
      async writeAll() {
        throw new Error("simulated target write failure");
      },
    }),
  });

  await assert.rejects(
    () => importer.importBindings({ stopLegacyBindings: true }),
    (error: unknown) => error instanceof LegacyImportError && error.code === "legacy-stop-failed",
  );
  // 源 bindings.json 逐字节还原（停止效果被撤销）。
  assert.equal(await readFile(join(sourceRootDir, "raft", "bindings.json"), "utf8"), originalJson);
  const sourceAfter = await createRaftBindingStore(sourceRootDir).readAll();
  assert.equal(sourceAfter.find((b) => b.bindingId === ID_A)!.desiredState, "Running");
  // 备份文件保留作证据；目标无 bindings.json。
  const raftEntries = await readdir(join(sourceRootDir, "raft"));
  assert.ok(raftEntries.some((name) => name.startsWith("bindings.json.pre-tinycode-import-")));
  assert.equal(existsSync(join(targetRootDir, "raft", "bindings.json")), false);
});

test("stopLegacyWatch 写前再探：进程运行中 / 锁复现 → 中止且源未动（grokbot 复核 2）", async () => {
  const { sourceRootDir } = await makeTempRoots();
  const { bindings, originalJson } = await seedSource(sourceRootDir);
  const sourceBindingsPath = join(sourceRootDir, "raft", "bindings.json");
  const base = {
    sourceBindingsPath,
    importedIds: new Set(bindings.map((b) => b.bindingId)),
    now: () => new Date("2026-10-02T00:00:00Z"),
  };

  // 进程运行中 → 拒绝写。
  await assert.rejects(
    () => stopLegacyWatch({ ...base, probeLegacyAppRunning: async () => true }),
    (error: unknown) => error instanceof LegacyImportError && error.code === "legacy-app-running",
  );
  assert.equal(await readFile(sourceBindingsPath, "utf8"), originalJson);

  // 值守锁在写前复现 → 拒绝写。
  await writeLiveLock(sourceRootDir, ID_A);
  await assert.rejects(
    () => stopLegacyWatch({ ...base, probeLegacyAppRunning: async () => false }),
    (error: unknown) => error instanceof LegacyImportError && error.code === "legacy-watch-held",
  );
  assert.equal(await readFile(sourceBindingsPath, "utf8"), originalJson);
  const raftEntries = await readdir(join(sourceRootDir, "raft"));
  assert.equal(raftEntries.some((name) => name.startsWith("bindings.json.pre-tinycode-import-")), false);
});

test("停止写校验：其余字段被篡改 → verify-failed + 源逐字节还原（grokbot 复核 3）", async () => {
  const { sourceRootDir } = await makeTempRoots();
  const { bindings, originalJson } = await seedSource(sourceRootDir);
  const sourceBindingsPath = join(sourceRootDir, "raft", "bindings.json");

  await assert.rejects(
    () =>
      stopLegacyWatch({
        sourceBindingsPath,
        importedIds: new Set(bindings.map((b) => b.bindingId)),
        now: () => new Date("2026-10-02T00:00:00Z"),
        probeLegacyAppRunning: async () => false,
        // 模拟写后即被并发篡改非授权字段（或写实现异常）：displayName 变了。
        writeBindingsFile: async (path, content) => {
          const tampered = JSON.parse(content) as {
            bindings: Array<{ displayName: string }>;
          };
          tampered.bindings[0]!.displayName = "hijacked";
          const { atomicWritePrivateTextFile } = await import("@zcode/shared/node");
          await atomicWritePrivateTextFile(path, `${JSON.stringify(tampered, null, 2)}\n`);
        },
      }),
    (error: unknown) =>
      error instanceof LegacyImportError &&
      error.code === "verify-failed" &&
      error.message.includes("unexpected field changes"),
  );
  assert.equal(await readFile(sourceBindingsPath, "utf8"), originalJson);
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

test("probeLegacyZCodeAppRunning：SingletonLock 活/死/格式异常/无（darwin）", async () => {
  if (process.platform !== "darwin") return;
  const base = join(tmpdir(), `raft-slock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const zcodeDir = join(base, "ZCode");
  const lockPath = join(zcodeDir, "SingletonLock");
  await mkdir(zcodeDir, { recursive: true });

  // 无锁 → 未运行。
  assert.equal(await probeLegacyZCodeAppRunning({ appSupportDir: base }), false);
  // 活 pid（target = <hostname>-<pid>，hostname 含 '-' 也能取到末段 pid）→ 运行中。
  await symlink(`${hostname()}-macbook-${process.pid}`, lockPath);
  assert.equal(await probeLegacyZCodeAppRunning({ appSupportDir: base }), true);
  // 死 pid（崩溃残留）→ 不算运行。
  await rm(lockPath);
  await symlink(`${hostname()}-${DEAD_PID}`, lockPath);
  assert.equal(await probeLegacyZCodeAppRunning({ appSupportDir: base }), false);
  // 格式异常（解析不出 pid）→ 保守视为运行。
  await rm(lockPath);
  await symlink("no-pid-here", lockPath);
  assert.equal(await probeLegacyZCodeAppRunning({ appSupportDir: base }), true);

  // 开发构建 "ZCode Dev"（同消费 .zcode 数据根）与 Preview 目录也各自探测：
  // 主目录无锁、Dev 目录活 pid → 运行中。
  await rm(lockPath);
  const devDir = join(base, "ZCode Dev");
  await mkdir(devDir, { recursive: true });
  await symlink(`${hostname()}-${process.pid}`, join(devDir, "SingletonLock"));
  assert.equal(await probeLegacyZCodeAppRunning({ appSupportDir: base }), true);
});

test("resolveAgentHomeKind：default（UUID≠bindingId）/ custom / unknown 三态", async () => {
  const { base } = await makeTempRoots();
  const root = join(base, ".zcode");
  const home = join(root, "agents", CONTAINER_A, "workspace");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".zcode-agent-home"), `${ID_A}\n`);

  const def = await resolveAgentHomeKind({
    dataRootDir: root,
    bindingId: ID_A,
    homeWorkspacePath: home,
  });
  assert.equal(def.kind, "default");
  if (def.kind === "default") {
    assert.equal(def.containerDirName, CONTAINER_A);
    assert.ok(def.homeRealPath.endsWith(join("agents", CONTAINER_A, "workspace")));
  }

  // custom：不在数据根 agents/ 下。
  const custom = await resolveAgentHomeKind({
    dataRootDir: root,
    bindingId: ID_A,
    homeWorkspacePath: join(base, "elsewhere", "home"),
  });
  assert.deepEqual(custom, { kind: "custom" });

  // unknown：位置对但标记缺失（Home 目录整体不存在同理）。
  const missing = await resolveAgentHomeKind({
    dataRootDir: root,
    bindingId: ID_A,
    homeWorkspacePath: join(root, "agents", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeffff", "workspace"),
  });
  assert.equal(missing.kind, "unknown-home");

  // unknown：标记内容与 bindingId 不符。
  const mismatch = await resolveAgentHomeKind({
    dataRootDir: root,
    bindingId: ID_B,
    homeWorkspacePath: home,
  });
  assert.equal(mismatch.kind, "unknown-home");

  // unknown：空/相对路径。
  const invalid = await resolveAgentHomeKind({
    dataRootDir: root,
    bindingId: ID_A,
    homeWorkspacePath: "",
  });
  assert.equal(invalid.kind, "unknown-home");

  // macOS /var 根别名：数据根存在而 Home 已删除时仍按位置判（不误判 custom）。
  const alias = await resolveAgentHomeKind({
    dataRootDir: root,
    bindingId: ID_A,
    homeWorkspacePath: home.replace(/^\/private/, ""),
  });
  assert.equal(alias.kind, "default");
});

test("启动门：旧侧持锁 → ErrorPaused(legacy_watch_held)；未持锁 → 放行", async () => {
  const { sourceRootDir, targetRootDir } = await makeTempRoots();
  await seedSource(sourceRootDir);
  const binding = makeBinding({ homeWorkspacePath: join(targetRootDir, "agents", CONTAINER_A, "workspace") });
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
  const importer = makeImporter(join(targetRootDir, "no-source"), targetRootDir);
  assert.deepEqual(await importer.detect(), { status: "not-available", reason: "already-declined" });
});
