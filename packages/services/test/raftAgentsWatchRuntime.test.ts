/**
 * 值守编排器（watchRuntime）测试。
 * 覆盖：启动链顺序（CLI→MEMORY 门→锁内换代→spawn→D8 drain）、幂等入口、
 * 各失败分支的 ErrorPaused 置位、意图翻转中止、onExit 意外退出、stop/恢复/关停、
 * 每绑定线性化与并发合并。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { RaftAgentBinding, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import {
  backlogDrainCommandId,
  buildBacklogDrainPrompt,
} from "../src/raft-agents/app/prompts.js";
import { createRaftActivityFeed, type RaftActivityFeed } from "../src/raft-agents/app/activityFeed.js";
import { createRaftWatchRuntime, type RaftMemoryGatePort } from "../src/raft-agents/app/watchRuntime.js";
import type { RaftBindingStorePort, RaftSessionPort, RaftSessionSendOutcome } from "../src/raft-agents/app/ports.js";
import type { BridgeBindingRef, BridgeStartResult, BridgeExitInfo, BridgeSupervisorPort } from "../src/raft-agents/app/bridgePorts.js";
import { createRaftStoreWriteLock } from "../src/raft-agents/app/storeLock.js";

const BINDING_ID = "99999999-8888-4777-a666-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLI_PATH = "/fake/raft/dist/index.js";

function makeBinding(overrides: Partial<RaftAgentBinding> = {}): RaftAgentBinding {
  return {
    bindingId: BINDING_ID,
    displayName: "t0-test-agent",
    raftOrigin: "https://raft.example.com",
    serverId: "srv-1",
    raftAgentId: AGENT_ID,
    profileSlug: "t0-test-agent",
    homeWorkspacePath: "/tmp/raft-homes/agent-a",
    mainSessionRef: { sessionId: "sess-7", sessionGeneration: 1 },
    desiredState: "Running",
    autostartConsent: false,
    adapterInstance: BINDING_ID,
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

/** 可变 store 假件：writeAll 生效；readScript 可模拟"锁内重读结果与初读不同"。 */
function fakeStore(initial: RaftAgentBinding[]) {
  let current = [...initial];
  const writes: RaftAgentBinding[][] = [];
  let readScript: (() => RaftAgentBinding[]) | undefined;
  const port: RaftBindingStorePort = {
    async readAll() {
      return readScript ? readScript() : [...current];
    },
    async writeAll(bindings) {
      writes.push(bindings);
      current = [...bindings];
    },
  };
  return {
    port,
    writes,
    current: () => current,
    setReadScript(script: (() => RaftAgentBinding[]) | undefined) {
      readScript = script;
    },
  };
}

/** 可编程 supervisor 假件：start 按脚本回放，exit() 手动触发 onExit 通知。 */
function fakeSupervisor(startScript: BridgeStartResult[] = [{ ok: true, pid: 4321 }]) {
  const startCalls: Array<{ ref: BridgeBindingRef; cliPath: string }> = [];
  const stopCalls: string[] = [];
  let stopAllCalls = 0;
  let running = new Set<string>();
  const exitListeners: Array<(info: BridgeExitInfo) => void> = [];
  let i = 0;
  const supervisor: BridgeSupervisorPort = {
    async start(ref, cliPath) {
      startCalls.push({ ref, cliPath });
      const result = startScript[Math.min(i, startScript.length - 1)];
      i += 1;
      if (result.ok) running.add(ref.bindingId);
      return result;
    },
    async stop(bindingId) {
      stopCalls.push(bindingId);
      running.delete(bindingId);
    },
    async stopAll() {
      stopAllCalls += 1;
      running = new Set();
    },
    terminateAllNow() {
      running = new Set();
    },
    isRunning: (bindingId) => running.has(bindingId),
    onExit(listener) {
      exitListeners.push(listener);
      return () => {
        const idx = exitListeners.indexOf(listener);
        if (idx >= 0) exitListeners.splice(idx, 1);
      };
    },
  };
  return {
    supervisor,
    startCalls,
    stopCalls,
    stopAllCalls: () => stopAllCalls,
    async exit(info: BridgeExitInfo) {
      if (!info.requested) running.delete(info.bindingId);
      for (const listener of exitListeners) listener(info);
    },
  };
}

function fakeSessions(
  scripts: RaftSessionSendOutcome[] = [{ ok: true, duplicate: false }],
  resumeScript: Array<{ ok: true } | { ok: false; code: "failed"; detail?: string }> = [{ ok: true }],
  createScript: Array<{ ok: true; sessionId: string } | { ok: false; code: "failed"; detail?: string }> = [],
) {
  const sent: Array<{ workspacePath: string; sessionId: string; commandId: string; text: string }> = [];
  const resumes: Array<{
    workspacePath: string;
    sessionId: string;
    agentMemory: { homeRoot: string; agentName?: string };
    officialMcpServers: ZCodeOfficialMcpServerRef[];
  }> = [];
  const creates: Array<{
    workspacePath: string;
    agentMemory: { homeRoot: string; agentName?: string };
    officialMcpServers: ZCodeOfficialMcpServerRef[];
  }> = [];
  let i = 0;
  let j = 0;
  let k = 0;
  const port: RaftSessionPort = {
    async sendQueuedText(params) {
      sent.push(params);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i += 1;
      return script;
    },
    async createAgentSession(params) {
      creates.push(params);
      const fallback = createScript.length > 0 ? createScript[createScript.length - 1] : { ok: true, sessionId: "sess-new" };
      const script = createScript[Math.min(k, createScript.length - 1)] ?? fallback;
      k += 1;
      return script as { ok: true; sessionId: string } | { ok: false; code: "failed"; detail?: string };
    },
    async resumeAgentSession(params) {
      resumes.push(params);
      const script = resumeScript[Math.min(j, resumeScript.length - 1)];
      j += 1;
      return script;
    },
  };
  return { port, sent, resumes, creates };
}

const MCP_REFS: ZCodeOfficialMcpServerRef[] = [
  { name: "raft-agent-tools", env: [{ name: "ZCODE_RAFT_BINDING_ID", value: BINDING_ID }] },
];

const okCli = { resolve: async () => ({ ok: true as const, cliPath: CLI_PATH, version: "0.0.24" }) };

function makeRuntime(overrides: {
  store?: ReturnType<typeof fakeStore>;
  supervisor?: ReturnType<typeof fakeSupervisor>;
  sessions?: ReturnType<typeof fakeSessions>;
  cli?: typeof okCli;
  memory?: RaftMemoryGatePort;
  resolveOfficialMcpServers?: () => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
  feed?: RaftActivityFeed;
} = {}) {
  const store = overrides.store ?? fakeStore([makeBinding()]);
  const supervisor = overrides.supervisor ?? fakeSupervisor();
  const sessions = overrides.sessions ?? fakeSessions();
  const runtime = createRaftWatchRuntime({
    store: store.port,
    lock: createRaftStoreWriteLock(),
    sessions: sessions.port,
    supervisor: supervisor.supervisor,
    cli: overrides.cli ?? okCli,
    memory: overrides.memory,
    resolveOfficialMcpServers: overrides.resolveOfficialMcpServers ?? (async () => MCP_REFS),
    clock: { nowIso: () => "2026-09-30T12:00:00.000Z" },
    ...(overrides.feed ? { feed: overrides.feed } : {}),
  });
  return { runtime, store, supervisor, sessions };
}

test("startWatch 成功链：换代+1 持久化 → spawn(带 cliPath) → D8 drain(代次幂等键) → Running", async () => {
  const { runtime, store, supervisor, sessions } = makeRuntime();
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.deepEqual(outcome, { ok: true });

  // 换代 1→2 已持久化（锁内写）。
  assert.equal(store.current()[0].mainSessionRef?.sessionGeneration, 2);
  assert.equal(store.writes.length, 1);
  // spawn 参数：绑定引用与 CLI 路径。
  assert.equal(supervisor.startCalls.length, 1);
  assert.deepEqual(supervisor.startCalls[0].ref, {
    bindingId: BINDING_ID,
    profileSlug: "t0-test-agent",
    raftAgentId: AGENT_ID,
  });
  assert.equal(supervisor.startCalls[0].cliPath, CLI_PATH);
  // 会话恢复先于 bridge 启动（spec §3 顺序），重发记忆作用域与官方 MCP 引用。
  assert.equal(sessions.resumes.length, 1);
  assert.equal(sessions.resumes[0].sessionId, "sess-7");
  assert.equal(sessions.resumes[0].workspacePath, "/tmp/raft-homes/agent-a");
  assert.equal(sessions.resumes[0].agentMemory.homeRoot, "/tmp/raft-homes/agent-a");
  assert.equal(sessions.resumes[0].agentMemory.agentName, "t0-test-agent");
  assert.equal(sessions.resumes[0].officialMcpServers, MCP_REFS);
  // D8 drain：commandId = bindingId+代次，文本含工具引导与代次，无凭据形态。
  assert.equal(sessions.sent.length, 1);
  assert.equal(sessions.sent[0].commandId, `raft-drain:${BINDING_ID}:2`);
  assert.equal(sessions.sent[0].sessionId, "sess-7");
  assert.equal(sessions.sent[0].workspacePath, "/tmp/raft-homes/agent-a");
  assert.ok(sessions.sent[0].text.includes("raft_message_check"));
  assert.ok(!sessions.sent[0].text.includes("sk_agent_"));
  // 投影：覆盖层 Running。
  assert.equal(runtime.resolveRunState(store.current()[0]), "Running");
});

test("幂等入口：bridge 已在跑则直接成功，不换代/不 spawn/不 drain", async () => {
  const supervisor = fakeSupervisor();
  // 预置为已运行（模拟先前 startWatch 的结果）。
  await supervisor.supervisor.start({ bindingId: BINDING_ID, profileSlug: "s", raftAgentId: AGENT_ID }, CLI_PATH);
  const { runtime, store, sessions } = makeRuntime({ supervisor });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.deepEqual(outcome, { ok: true });
  assert.equal(supervisor.startCalls.length, 1, "无第二次 spawn");
  assert.equal(store.writes.length, 0, "未再换代");
  assert.equal(sessions.sent.length, 0, "未再 drain");
  assert.equal(runtime.resolveRunState(store.current()[0]), "Running");
});

test("MEMORY 门失败：ErrorPaused(memory_unavailable)，不换代不 spawn（顺序红线）", async () => {
  const memory: RaftMemoryGatePort = {
    verifyMemoryAvailable: async () => ({ ok: false, code: "MemoryUnreadable", detail: "EACCES" }),
  };
  const { runtime, store, supervisor, sessions } = makeRuntime({ memory });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "MemoryUnavailable");
  assert.ok(!outcome.ok && outcome.detail === "MemoryUnreadable: EACCES");
  assert.equal(store.writes.length, 0, "未换代");
  assert.equal(supervisor.startCalls.length, 0, "MEMORY 门未过不碰 bridge");
  assert.equal(sessions.sent.length, 0);
  assert.equal(sessions.resumes.length, 0, "MEMORY 门未过不恢复会话");
  assert.deepEqual(runtime.resolveRunState(store.current()[0]), {
    kind: "ErrorPaused",
    reason: "memory_unavailable",
  });
});

test("CLI 不可用：ErrorPaused(cli_unavailable)，先于 MEMORY 门与 spawn", async () => {
  const gateCalls: string[] = [];
  const memory: RaftMemoryGatePort = {
    verifyMemoryAvailable: async (input) => {
      gateCalls.push(input.homeWorkspacePath);
      return { ok: true };
    },
  };
  const { runtime, store, supervisor } = makeRuntime({
    cli: { resolve: async () => ({ ok: false as const, code: "CliMissing" as const, detail: "not found" }) },
    memory,
  });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.ok(!outcome.ok && outcome.code === "CliUnavailable");
  assert.equal(gateCalls.length, 0, "CLI 前置失败不再走记忆门");
  assert.equal(supervisor.startCalls.length, 0);
  assert.deepEqual(runtime.resolveRunState(store.current()[0]), {
    kind: "ErrorPaused",
    reason: "cli_unavailable",
  });
});

test("锁内意图翻转：start 期间用户停止 → 中止且不写不 spawn", async () => {
  const store = fakeStore([makeBinding()]);
  // 初读 Running（锁外），锁内重读已变 ReadyStopped（模拟 setDesiredState 先落盘）。
  let readCount = 0;
  store.setReadScript(() => {
    readCount += 1;
    return readCount <= 1 ? [makeBinding()] : [makeBinding({ desiredState: "ReadyStopped" })];
  });
  const { runtime, supervisor } = makeRuntime({ store });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.ok(!outcome.ok && outcome.code === "NotRunningIntent");
  assert.equal(supervisor.startCalls.length, 0);
  assert.equal(store.writes.length, 0);
  // 中止不置任何覆盖层（store 本体未被本次修改，投影回落推导）。
  assert.equal(runtime.resolveRunState(store.current()[0]), undefined);
});

test("spawn 失败分支：EarlyExit → ErrorPaused(bridge_exit)，换代已持久化；AlreadyRunning 兜底成功", async () => {
  const fail = fakeSupervisor([{ ok: false, code: "EarlyExit", detail: "exit 1" }]);
  const first = makeRuntime({ supervisor: fail });
  const failOutcome = await first.runtime.startWatch(BINDING_ID);
  assert.ok(!failOutcome.ok && failOutcome.code === "BridgeStartFailed");
  assert.equal(first.store.writes.length, 1, "换代先于 spawn，失败也保留代次");
  assert.deepEqual(first.runtime.resolveRunState(first.store.current()[0]), {
    kind: "ErrorPaused",
    reason: "bridge_exit",
  });

  const already = fakeSupervisor([{ ok: false, code: "AlreadyRunning" }]);
  const second = makeRuntime({ supervisor: already });
  const okOutcome = await second.runtime.startWatch(BINDING_ID);
  assert.deepEqual(okOutcome, { ok: true });
  assert.equal(second.sessions.sent.length, 0, "AlreadyRunning 不重复 drain");
  assert.equal(second.runtime.resolveRunState(second.store.current()[0]), "Running");
});

test("onExit：意外退出置 ErrorPaused(bridge_exit)，requested 不算故障", async () => {
  const { runtime, store, supervisor } = makeRuntime();
  await runtime.startWatch(BINDING_ID);
  assert.equal(runtime.resolveRunState(store.current()[0]), "Running");

  await supervisor.exit({
    bindingId: BINDING_ID,
    requested: false,
    code: 1,
    signal: null,
    stderrTail: "bridge crashed",
  });
  assert.deepEqual(runtime.resolveRunState(store.current()[0]), {
    kind: "ErrorPaused",
    reason: "bridge_exit",
  });

  // 恢复：requested 退出不置错；下次 startWatch 成功后覆盖层清为 Running。
  await supervisor.exit({ bindingId: BINDING_ID, requested: true, code: 0, signal: null, stderrTail: "" });
  assert.deepEqual(runtime.resolveRunState(store.current()[0]), {
    kind: "ErrorPaused",
    reason: "bridge_exit",
  }, "requested 退出不清除既有 ErrorPaused（那属于新一次启动的事）");
  const again = await runtime.startWatch(BINDING_ID);
  assert.deepEqual(again, { ok: true });
  assert.equal(runtime.resolveRunState(store.current()[0]), "Running");
});

test("drain 提交失败（transport）：bridge 不回滚，结果仍成功，覆盖层 Running", async () => {
  const sessions = fakeSessions([{ ok: false, code: "transport", detail: "rpc down" }]);
  const { runtime, store, supervisor } = makeRuntime({ sessions });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.deepEqual(outcome, { ok: true });
  assert.equal(supervisor.startCalls.length, 1, "bridge 保持运行");
  assert.equal(runtime.resolveRunState(store.current()[0]), "Running");
});

test("并发合并：同绑定两次并发 startWatch 只执行一次链路", async () => {
  const supervisor = fakeSupervisor();
  const { runtime, store } = makeRuntime({ supervisor });
  const [a, b] = await Promise.all([runtime.startWatch(BINDING_ID), runtime.startWatch(BINDING_ID)]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(supervisor.startCalls.length, 1);
  assert.equal(store.writes.length, 1, "只换代一次");
});

test("stopWatch：等 bridge 退出并清覆盖层；disposeAllAndWait 停全部", async () => {
  const { runtime, store, supervisor } = makeRuntime();
  await runtime.startWatch(BINDING_ID);
  await runtime.stopWatch(BINDING_ID);
  assert.deepEqual(supervisor.stopCalls, [BINDING_ID]);
  // 停止后 desiredState 仍为 Running（落盘是调用方职责），投影回落 Starting。
  assert.equal(runtime.resolveRunState(store.current()[0]), undefined);

  await runtime.startWatch(BINDING_ID);
  await runtime.disposeAllAndWait();
  assert.equal(supervisor.stopAllCalls(), 1);
  assert.equal(runtime.resolveRunState(store.current()[0]), undefined);
});

test("B2 活动摘要：bridge 起来后挂接主会话订阅并记连接，drain 计入待处理；停值守退订并记断开", async () => {
  const subscribed: string[] = [];
  const disposed: string[] = [];
  const feed = createRaftActivityFeed({
    sessions: {
      subscribeActivity(params) {
        subscribed.push(params.sessionId);
        return { dispose: () => disposed.push(params.sessionId) };
      },
    },
  });
  const { runtime } = makeRuntime({ feed });
  await runtime.startWatch(BINDING_ID);
  assert.deepEqual(subscribed, ["sess-7"]);
  assert.equal(feed.resolveLive(BINDING_ID)?.pendingCount, 1, "积压 drain 提交成功计入待处理");
  await runtime.stopWatch(BINDING_ID);
  assert.deepEqual(disposed, ["sess-7"]);
  assert.deepEqual(
    feed.drain(BINDING_ID, 10).events.map((e) => e.hookEventName),
    ["SessionStart", "SessionEnd"],
  );
});

test("recoverAllDesiredRunning：只恢复 desiredState=Running 的绑定，彼此独立", async () => {
  const other = makeBinding({
    bindingId: "11111111-2222-4333-8444-555555555555",
    profileSlug: "agent-b",
    mainSessionRef: { sessionId: "sess-8", sessionGeneration: 4 },
  });
  const stopped = makeBinding({
    bindingId: "33333333-2222-4333-8444-555555555555",
    profileSlug: "agent-c",
    desiredState: "ReadyStopped",
  });
  const store = fakeStore([makeBinding(), other, stopped]);
  const supervisor = fakeSupervisor();
  const { runtime } = makeRuntime({ store, supervisor });
  await runtime.recoverAllDesiredRunning();
  assert.equal(supervisor.startCalls.length, 2);
  const startedIds = supervisor.startCalls.map((c) => c.ref.bindingId).sort();
  assert.deepEqual(startedIds, [BINDING_ID, "11111111-2222-4333-8444-555555555555"].sort());
});

test("recoverAllDesiredRunning：存储损坏 → 不拉起任何 bridge（值守暂停，fail-closed）", async () => {
  const store = fakeStore([makeBinding()]);
  // readAll 抛错模拟绑定文件损坏（RaftBindingStoreCorruptError 形态）。
  store.port.readAll = async () => {
    throw new Error("raft bindings store is corrupt: /x/raft/bindings.json");
  };
  const supervisor = fakeSupervisor();
  const { runtime } = makeRuntime({ store, supervisor });
  await runtime.recoverAllDesiredRunning(); // 不抛、不拉起，静默暂停等待恢复。
  assert.equal(supervisor.startCalls.length, 0);
});

test("幂等键与文本：代次参与 commandId；prompt 含绑定/代次与工具引导", () => {
  assert.equal(backlogDrainCommandId(BINDING_ID, 3), `raft-drain:${BINDING_ID}:3`);
  assert.notEqual(backlogDrainCommandId(BINDING_ID, 3), backlogDrainCommandId(BINDING_ID, 4));
  const text = buildBacklogDrainPrompt({ bindingId: BINDING_ID, generation: 3, nowIso: "2026-09-30T12:00:00Z" });
  assert.ok(text.includes(BINDING_ID));
  assert.ok(text.includes("代次=3"));
  assert.ok(text.includes("raft_message_send"));
  assert.ok(text.includes("不要在命令行里直接调用 raft 命令"), "含 CLI 直调守卫（D5 防绕过）");
  assert.ok(text.includes("backlog drain"));
  assert.ok(!text.includes("sk_agent_"));
});

test("官方 MCP 引用不可用：fail-closed 不换代不恢复不 spawn", async () => {
  const { runtime, store, supervisor, sessions } = makeRuntime({
    resolveOfficialMcpServers: async () => undefined,
  });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.ok(!outcome.ok && outcome.code === "McpUnavailable");
  assert.equal(store.writes.length, 0);
  assert.equal(sessions.resumes.length, 0);
  assert.equal(supervisor.startCalls.length, 0);
  // 置 ErrorPaused(mcp_unavailable)：否则 UI 一直投影 Starting，用户看不到原因（评审 b51caf5c）。
  assert.deepEqual(runtime.resolveRunState(store.current()[0]), {
    kind: "ErrorPaused",
    reason: "mcp_unavailable",
  });
});

test("resume 失败且重建也失败：置 ErrorPaused(session_unavailable)，换代已保留", async () => {
  const sessions = fakeSessions([{ ok: true, duplicate: false }], [
    { ok: false, code: "failed", detail: "Session not found: sess_old" },
  ], [
    { ok: false, code: "failed", detail: "rpc down" },
  ]);
  const { runtime, store, supervisor } = makeRuntime({ sessions });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.ok(!outcome.ok && outcome.code === "SessionResumeFailed");
  assert.ok(!outcome.ok && outcome.detail === "rpc down");
  assert.equal(supervisor.startCalls.length, 0, "重建未过不启动 bridge");
  assert.equal(store.writes.length, 1, "换代已持久化（幂等键唯一性保留）");
  // 置 ErrorPaused(session_unavailable)（评审 b51caf5c）：投影可诊断而非一直 Starting；
  // 下次 startWatch 成功或 stopWatch 清除。
  assert.deepEqual(runtime.resolveRunState(store.current()[0]), {
    kind: "ErrorPaused",
    reason: "session_unavailable",
  });
});

test("resume 失败自动重建：改绑新会话（代次重置 1）→ bridge 照常启动 → drain 用新会话", async () => {
  const sessions = fakeSessions([{ ok: true, duplicate: false }], [
    { ok: false, code: "failed", detail: "Session not found: sess_old" },
  ], [
    { ok: true, sessionId: "sess_rebuilt" },
  ]);
  const { runtime, store, supervisor } = makeRuntime({ sessions });
  const outcome = await runtime.startWatch(BINDING_ID);
  assert.ok(outcome.ok, outcome.ok ? "" : String(outcome.code));
  // 改绑持久化：新会话 + 代次 1（旧 fencing 随旧会话失效）。
  const persisted = store.current()[0];
  assert.equal(persisted.mainSessionRef?.sessionId, "sess_rebuilt");
  assert.equal(persisted.mainSessionRef?.sessionGeneration, 1);
  // 重建请求带齐记忆作用域与官方 MCP 引用（冷恢复同语义）。
  assert.equal(sessions.creates.length, 1);
  assert.deepEqual(sessions.creates[0].agentMemory, { homeRoot: persisted.homeWorkspacePath, agentName: persisted.displayName });
  assert.equal(sessions.creates[0].officialMcpServers.length, 1);
  // bridge 启动且 drain 指向新会话、代次 1。
  assert.equal(supervisor.startCalls.length, 1);
  assert.equal(sessions.sent[0].sessionId, "sess_rebuilt");
  assert.equal(sessions.sent[0].commandId, `raft-drain:${BINDING_ID}:1`);
  assert.deepEqual(runtime.resolveRunState(persisted), "Running");
});
