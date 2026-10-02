// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 二期 A1（task #11）测试：管理动作（重启/重置/删除拆除）、懒建会话、
 * 打开会话、记忆只读视图边界、本机凭据枚举（无 apiKey 外泄）、凭据预核验
 * （临时 profile 即毁）、复用凭据接入、活动记录。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RaftAgentBinding, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import { createRaftActivityTracker } from "../src/raft-agents/app/activity.js";
import { createAgentHomeProvisioningStep } from "../src/raft-agents/app/agentHomeProvisioning.js";
import { createRaftAgentManagement } from "../src/raft-agents/app/management.js";
import type { ClockPort, RaftCliPort, RaftSessionPort } from "../src/raft-agents/app/ports.js";
import { createRaftAgentsService } from "../src/raft-agents/app/raftAgentsService.js";
import { createRaftStoreWriteLock } from "../src/raft-agents/app/storeLock.js";
import { createRaftWatchRuntime } from "../src/raft-agents/app/watchRuntime.js";
import { createAgentHomeAdapter } from "../src/raft-agents/adapters/agentHome.js";
import { createRaftBindingStore } from "../src/raft-agents/adapters/bindingStore.js";
import { createRaftProfilesCatalog } from "../src/raft-agents/adapters/profilesCatalog.js";
import type { BridgeExitInfo, BridgeStartResult, BridgeSupervisorPort } from "../src/raft-agents/app/bridgePorts.js";

const BINDING_ID = "99999999-8888-4777-a666-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const fixedClock: ClockPort = { nowIso: () => "2026-10-01T00:00:00.000Z" };
const MCP_REFS: ZCodeOfficialMcpServerRef[] = [
  { name: "raft-agent-tools", env: [{ name: "ZCODE_RAFT_BINDING_ID", value: BINDING_ID }] },
];

const okCli: Pick<RaftCliPort, "resolve"> = {
  resolve: async () => ({ ok: true, cliPath: "/fake/raft/dist/index.js", version: "0.0.24" }),
};

function fakeCli(): RaftCliPort & {
  loginCalls: Array<Parameters<RaftCliPort["login"]>[0]>;
  destroyCalls: string[];
} {
  const loginCalls: Array<Parameters<RaftCliPort["login"]>[0]> = [];
  const destroyCalls: string[] = [];
  return {
    loginCalls,
    destroyCalls,
    resolve: async () => ({ ok: true, cliPath: "/fake/raft", version: "0.0.24" }),
    login: async (params) => {
      loginCalls.push(params);
      return { ok: true, agentName: "Fake Agent" };
    },
    whoami: async () => ({
      agentId: AGENT_ID,
      serverUrl: "https://raft.example.com",
      serverId: "server-1",
    }),
    destroyProfile: async (params) => {
      destroyCalls.push(params.profileDir);
    },
  };
}

function makeBinding(homeWorkspacePath: string, overrides: Partial<RaftAgentBinding> = {}): RaftAgentBinding {
  return {
    bindingId: BINDING_ID,
    displayName: "t11-test-agent",
    raftOrigin: "https://raft.example.com",
    serverId: "srv-1",
    raftAgentId: AGENT_ID,
    profileSlug: "t11-test-agent",
    homeWorkspacePath,
    mainSessionRef: { sessionId: "sess-old", sessionGeneration: 3 },
    desiredState: "Running",
    autostartConsent: false,
    adapterInstance: BINDING_ID,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

/** 会话端口假件：记录调用，create/resume/close 按脚本回放。 */
function fakeSessions(
  createScript: Array<{ ok: true; sessionId: string } | { ok: false; code: "failed"; detail?: string }> = [
    { ok: true, sessionId: "sess-new" },
  ],
  resumeScript: Array<{ ok: true } | { ok: false; code: "failed"; detail?: string }> = [{ ok: true }],
  closeScript: Array<{ ok: true } | { ok: false; code: "failed"; detail?: string }> = [{ ok: true }],
) {
  const sent: Array<{ sessionId: string; commandId: string }> = [];
  const creates: Array<{ workspacePath: string; agentMemory: unknown; officialMcpServers: unknown }> = [];
  const resumes: Array<{ sessionId: string; agentMemory: unknown; officialMcpServers: unknown }> = [];
  const closes: Array<{ workspacePath: string; sessionId: string }> = [];
  let i = 0;
  let j = 0;
  let k = 0;
  let m = 0;
  const port: RaftSessionPort = {
    async sendQueuedText(params) {
      sent.push({ sessionId: params.sessionId, commandId: params.commandId });
      return { ok: true, duplicate: false };
    },
    async createAgentSession(params) {
      creates.push(params);
      const script = createScript[Math.min(i, createScript.length - 1)];
      i += 1;
      return script;
    },
    async resumeAgentSession(params) {
      resumes.push(params);
      const script = resumeScript[Math.min(j, resumeScript.length - 1)];
      j += 1;
      return script;
    },
    async closeAgentSession(params) {
      closes.push(params);
      const script = closeScript[Math.min(k, closeScript.length - 1)];
      k += 1;
      return script;
    },
  };
  void m;
  return { port, sent, creates, resumes, closes };
}

function fakeSupervisor(startScript: BridgeStartResult[] = [{ ok: true, pid: 4321 }]) {
  const startCalls: string[] = [];
  const stopCalls: string[] = [];
  const running = new Set<string>();
  const exitListeners: Array<(info: BridgeExitInfo) => void> = [];
  let i = 0;
  const supervisor: BridgeSupervisorPort = {
    async start(ref) {
      startCalls.push(ref.bindingId);
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
      running.clear();
    },
    terminateAllNow() {
      running.clear();
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
  return { supervisor, startCalls, stopCalls, running };
}

/** 组一个近似宿主栈的小型装配（真实 store/memory/activity + 假件 cli/sessions/supervisor）。 */
async function buildStack(
  dataRoot: string,
  sessions: ReturnType<typeof fakeSessions>,
  supervisor: ReturnType<typeof fakeSupervisor>,
  cli: RaftCliPort,
  emitBindingsChanged?: (next: RaftAgentBinding[]) => void,
) {
  const store = createRaftBindingStore(dataRoot);
  const lock = createRaftStoreWriteLock();
  const memory = createAgentHomeAdapter();
  const activity = createRaftActivityTracker({ clock: fixedClock });
  const resolveOfficialMcpServers = async () => MCP_REFS;
  const runtime = createRaftWatchRuntime({
    store,
    lock,
    sessions: sessions.port,
    supervisor: supervisor.supervisor,
    cli,
    memory,
    resolveOfficialMcpServers,
    activity,
    clock: fixedClock,
    emitBindingsChanged,
  });
  const management = createRaftAgentManagement({
    store,
    lock,
    sessions: sessions.port,
    memory,
    runtime,
    resolveOfficialMcpServers,
    activity,
    clock: fixedClock,
    emitBindingsChanged,
  });
  const service = createRaftAgentsService({
    cli,
    store,
    clock: fixedClock,
    dataRootDir: dataRoot,
    provisioningSteps: [createAgentHomeProvisioningStep(memory)],
    storeWriteLock: lock,
    resolveRunState: runtime.resolveRunState,
    memory,
    profilesCatalog: createRaftProfilesCatalog(join(dataRoot, "raft", "profiles")),
    management,
    activity,
    onDesiredStateChanged: ({ bindingId, desired }) => {
      void (desired === "Running" ? runtime.startWatch(bindingId) : runtime.stopWatch(bindingId)).catch(() => {});
    },
  });
  return { service, store, memory, activity, management, runtime };
}

async function withDataRoot(fn: (dataRoot: string) => Promise<void>): Promise<void> {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-a1-"));
  try {
    await fn(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

// ── 重启 ──

test("restartBinding：Running 绑定 → 停 bridge → 换新会话（代次重置 1）→ 自动恢复值守", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.restartBinding(BINDING_ID);
    assert.equal(result.ok, true);

    // 换会话：create 收到同 Home 的 agentMemory 与官方 MCP。
    assert.equal(sessions.creates.length, 1);
    assert.equal(sessions.creates[0].workspacePath, home);
    const memoryArg = sessions.creates[0].agentMemory as { homeRoot: string; agentName: string };
    assert.equal(memoryArg.homeRoot, home);
    assert.equal((sessions.creates[0].officialMcpServers as unknown[]).length, MCP_REFS.length);
    // 改绑：指向新会话。重启本身把代次重置为 1，随后自动恢复的 startWatch 再 +1 → 2
    //（drain 幂等键用 2 也印证了这一点）。
    const rebound = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.deepEqual(rebound?.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 2 });
    // 重启本身不 resume；随后自动恢复的 startWatch 因引用已存在走 resume 路径
    //（resume 的是新会话；旧会话 sess-old 不再被引用，留作历史）。
    assert.equal(sessions.resumes.length, 1);
    assert.equal((sessions.resumes[0] as { sessionId: string }).sessionId, "sess-new");
    // 恢复值守：startWatch 在段外执行，bridge 重新拉起 + drain 投到新会话。
    assert.equal(supervisor.startCalls.length, 1);
    assert.equal(sessions.sent.length, 1);
    assert.equal(sessions.sent[0].sessionId, "sess-new");
    assert.equal(sessions.sent[0].commandId, `raft-drain:${BINDING_ID}:2`);
  });
});

test("restartBinding：Stopped 绑定换会话但不恢复值守；未知绑定 NotFound", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.store.writeAll([makeBinding(home, { desiredState: "ReadyStopped" })]);

    assert.equal((await stack.service.restartBinding(BINDING_ID)).ok, true);
    assert.equal(supervisor.startCalls.length, 0);
    // Stopped 绑定无后续 startWatch：改绑结果就是重启写入的代次 1（重置语义直读）。
    const rebound = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.deepEqual(rebound?.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 1 });
    assert.deepEqual(
      (await stack.service.restartBinding("11111111-2222-4333-8444-555555555555")).code,
      "NotFound",
    );
  });
});

test("换会话广播：restart/reset 的改绑落盘与换代 +1 各 fire 一次（编号如实、全量列表）", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions([
      { ok: true, sessionId: "sess-new" },
      { ok: true, sessionId: "sess-newer" },
    ]);
    const supervisor = fakeSupervisor();
    // 记录每次广播的 (sessionId, generation) 投影，验证顺序与代次语义。
    const events: Array<Array<{ sessionId: string | null; generation: number }>> = [];
    const emit = (next: RaftAgentBinding[]) => {
      events.push(
        next.map((b) => ({
          sessionId: b.mainSessionRef?.sessionId ?? null,
          generation: b.mainSessionRef?.sessionGeneration ?? 0,
        })),
      );
    };
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli(), emit);
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home)]);

    // Running 绑定 restart：swap 落盘（gen 1）→ 段外恢复 startWatch 换代 +1（gen 2）。
    assert.equal((await stack.service.restartBinding(BINDING_ID)).ok, true);
    // reset 同构：再换 sess-newer，swap（gen 1）→ 恢复（gen 2）。
    assert.equal((await stack.service.resetBinding(BINDING_ID)).ok, true);

    assert.deepEqual(events.flat(), [
      { sessionId: "sess-new", generation: 1 },
      { sessionId: "sess-new", generation: 2 },
      { sessionId: "sess-newer", generation: 1 },
      { sessionId: "sess-newer", generation: 2 },
    ]);
    // 每次广播都是全量列表（与 setDesiredState/createBinding 的 fire 语义一致）。
    for (const batch of events) assert.equal(batch.length, 1);
  });
});

test("换会话广播：创建失败不 fire（编号没变就不通知）", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions([{ ok: false, code: "failed", detail: "boom" }]);
    const supervisor = fakeSupervisor();
    const events: RaftAgentBinding[][] = [];
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli(), (next) => events.push(next));
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.restartBinding(BINDING_ID);
    assert.equal(result.ok, false);
    assert.equal(events.length, 0);
  });
});

test("restartBinding：新会话创建失败 → SessionCreateFailed，Running 绑定尽力恢复旧会话值守", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions([{ ok: false, code: "failed", detail: "boom" }]);
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.restartBinding(BINDING_ID);
    assert.deepEqual(result, { ok: false, code: "SessionCreateFailed", detail: "boom" });
    // 绑定引用未动（改绑只在 create 成功后发生）。
    const unchanged = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.equal(unchanged?.mainSessionRef?.sessionId, "sess-old");
    // 尽力恢复：resume 旧会话 + bridge 照常启动。
    assert.equal(sessions.resumes.length, 1);
    assert.equal(sessions.resumes[0].sessionId, "sess-old");
    assert.equal(supervisor.startCalls.length, 1);
  });
});

// ── 重置 ──

test("resetBinding：清记忆面并按模板重建（projects/ 保留）→ 换新会话", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    // 用户记忆演化：改写 MEMORY.md、加深层 notes、放 projects/。
    await writeFile(join(home, "MEMORY.md"), "# 用户改写后的记忆\n");
    await mkdir(join(home, "notes", "deep"), { recursive: true });
    await writeFile(join(home, "notes", "deep", "old.md"), "旧记忆");
    await mkdir(join(home, "projects", "repo-a"), { recursive: true });
    await writeFile(join(home, "projects", "repo-a", "file.txt"), "project artifact");
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.resetBinding(BINDING_ID);
    assert.equal(result.ok, true);

    // 记忆面回到初始模板（含 displayName），旧 notes 消失。
    const memory = await readFile(join(home, "MEMORY.md"), "utf8");
    assert.match(memory, /t11/);
    const files = await stack.service.listMemoryFiles(BINDING_ID);
    assert.ok(files.ok && !files.files.some((f) => f.path === "notes/deep/old.md"));
    // projects/ 不在记忆面、也不被重置波及。
    assert.equal(await readFile(join(home, "projects", "repo-a", "file.txt"), "utf8"), "project artifact");
    // 换会话 + 恢复值守（重置重绑代次 1，恢复值守再 +1 → 2）。
    const rebound = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.deepEqual(rebound?.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 2 });
    assert.equal(supervisor.startCalls.length, 1);
  });
});

test("resetBinding：记忆面清空失败 → MemoryResetFailed，不改绑", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.store.writeAll([makeBinding(home, { desiredState: "ReadyStopped" })]);
    // Home 不存在 → resetMemorySurface 失败。
    const result = await stack.service.resetBinding(BINDING_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "MemoryResetFailed");
    const unchanged = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.equal(unchanged?.mainSessionRef?.sessionId, "sess-old");
    assert.equal(sessions.creates.length, 0);
  });
});

// ── 打开会话（B3）──

test("openAgentSession：无主会话 → 懒建并改绑，不启动 bridge", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.store.writeAll([makeBinding(home, { desiredState: "ReadyStopped", mainSessionRef: null })]);
    assert.equal((await stack.service.list())[0]?.mainSessionId, null);

    const result = await stack.service.openAgentSession(BINDING_ID);
    assert.deepEqual(result, { ok: true, sessionId: "sess-new", workspacePath: home });
    assert.equal(sessions.creates.length, 1);
    assert.equal(supervisor.startCalls.length, 0);
    const rebound = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.deepEqual(rebound?.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 1 });
    // B3：列表投影直达主会话编号；懒建前为 null，打开后随改绑更新。
    assert.equal((await stack.service.list())[0]?.mainSessionId, "sess-new");
  });
});

test("openAgentSession：已有主会话 → resume（带记忆与 MCP）；resume 失败 → 重建", async () => {
  await withDataRoot(async (dataRoot) => {
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    // resume 成功路径。
    {
      const sessions = fakeSessions();
      const supervisor = fakeSupervisor();
      const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
      await stack.store.writeAll([makeBinding(home)]);
      const result = await stack.service.openAgentSession(BINDING_ID);
      assert.deepEqual(result, { ok: true, sessionId: "sess-old", workspacePath: home });
      assert.equal(sessions.resumes.length, 1);
      const resumeArg = sessions.resumes[0] as {
        agentMemory: { homeRoot: string };
        officialMcpServers: unknown[];
        raftBindingId?: string;
      };
      assert.equal(resumeArg.agentMemory.homeRoot, home);
      assert.equal(resumeArg.officialMcpServers.length, MCP_REFS.length);
      // pre-会话恢复补写绑定归属（B3 打开入口与值守恢复同款）。
      assert.equal(resumeArg.raftBindingId, BINDING_ID);
      assert.equal(sessions.creates.length, 0);
      assert.equal((await stack.service.list())[0]?.mainSessionId, "sess-old");
    }
    // resume 失败 → 重建改绑。
    {
      const sessions = fakeSessions();
      const supervisor = fakeSupervisor();
      const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
      await stack.store.writeAll([makeBinding(home)]);
      sessions.port.resumeAgentSession = async () => ({ ok: false, code: "failed", detail: "gone" });
      const result = await stack.service.openAgentSession(BINDING_ID);
      assert.deepEqual(result, { ok: true, sessionId: "sess-new", workspacePath: home });
      const rebound = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
      assert.deepEqual(rebound?.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 1 });
    }
  });
});

// ── 删除（removeBinding 编排）──

test("removeBinding：停 bridge + 关主会话 + 删记录 + 删 Home + 清活动；close 失败容忍", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions([], [{ ok: true }], [{ ok: false, code: "failed", detail: "closed=false" }]);
    const supervisor = fakeSupervisor();
    supervisor.running.add(BINDING_ID);
    const cli = fakeCli();
    const stack = await buildStack(dataRoot, sessions, supervisor, cli);
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home)]);
    stack.activity.record(BINDING_ID, "wake");

    const result = await stack.service.removeBinding(BINDING_ID, { deleteHome: true });

    assert.deepEqual(result, { home: "deleted" });
    assert.equal((await stack.store.readAll()).length, 0);
    // 拆除顺序：bridge 停止、会话 close 尝试过（失败被容忍，未抛出）。
    assert.ok(supervisor.stopCalls.includes(BINDING_ID));
    assert.equal(sessions.closes.length, 1);
    assert.equal(sessions.closes[0].sessionId, "sess-old");
    // Home 已删（默认位置 = 路径由 bindingId 派生，归属成立）。
    await assert.rejects(readFile(join(home, "MEMORY.md")));
    // 本地 profile 清理与活动清除。
    assert.equal(cli.destroyCalls.length, 1);
    assert.equal(stack.activity.resolveActivity(BINDING_ID), undefined);
  });
});

test("removeBinding：deleteHome=false 保留 Home", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.removeBinding(BINDING_ID, { deleteHome: false });
    assert.deepEqual(result, { home: "untouched", reason: "not_requested" });
    assert.match(await readFile(join(home, "MEMORY.md"), "utf8"), /t11/);
  });
});

test("removeBinding：用户自选 Home（无归属标记）→ 只清记忆面、保留目录、home=kept_memory_cleared", async (t) => {
  if (process.platform === "win32") return t.skip("符号链接需要权限");
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    // 用户已有的非空目录（含项目文件），绕过 provisioning 直接落绑定记录。
    const home = join(dataRoot, "user-chosen-home");
    await mkdir(join(home, "notes", "deep"), { recursive: true });
    await mkdir(join(home, "projects", "repo"), { recursive: true });
    await writeFile(join(home, "MEMORY.md"), "# 记忆\n");
    await writeFile(join(home, "AGENTS.md"), "# 指引\n");
    await writeFile(join(home, "notes", "deep", "a.md"), "旧记忆");
    await writeFile(join(home, "projects", "repo", "file.txt"), "project artifact");
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.removeBinding(BINDING_ID, { deleteHome: true });

    assert.deepEqual(result, { home: "kept_memory_cleared" });
    await assert.rejects(readFile(join(home, "MEMORY.md")));
    await assert.rejects(readFile(join(home, "notes", "deep", "a.md")));
    assert.equal(await readFile(join(home, "projects", "repo", "file.txt"), "utf8"), "project artifact");
    assert.ok((await stat(home)).isDirectory(), "用户目录保留");
  });
});

test("removeBinding：绑定时声明过归属的自选 Home → 整删（home=deleted）", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "claimed-home");
    await stack.memory.claimHomeOwnership({ bindingId: BINDING_ID, homeWorkspacePath: home });
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home)]);

    const result = await stack.service.removeBinding(BINDING_ID, { deleteHome: true });

    assert.deepEqual(result, { home: "deleted" });
    await assert.rejects(stat(home));
  });
});

test("removeBinding：Home 路径是符号链接 → 拒绝整删（home=untouched/refused），目标保全", async (t) => {
  if (process.platform === "win32") return t.skip("符号链接需要权限");
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const project = join(dataRoot, "real-project");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "main.ts"), "code");
    const linkedHome = join(dataRoot, "linked-home");
    await symlink(project, linkedHome);
    await stack.store.writeAll([makeBinding(linkedHome)]);

    const result = await stack.service.removeBinding(BINDING_ID, { deleteHome: true });

    assert.deepEqual(result, { home: "untouched", reason: "refused", detail: "home path is a symlink" });
    assert.equal(await readFile(join(project, "src", "main.ts"), "utf8"), "code");
  });
});

// ── 懒建（startWatch 首启创建）──

test("startWatch 懒建：mainSessionRef 为空 → 首启创建并改绑（代次 1）→ drain 用新会话", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await stack.store.writeAll([makeBinding(home, { mainSessionRef: null })]);

    const outcome = await stack.runtime.startWatch(BINDING_ID);
    assert.equal(outcome.ok, true);
    assert.equal(sessions.creates.length, 1);
    assert.equal(sessions.resumes.length, 0);
    const rebound = (await stack.store.readAll()).find((b) => b.bindingId === BINDING_ID);
    assert.deepEqual(rebound?.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 1 });
    assert.equal(sessions.sent[0].sessionId, "sess-new");
    assert.equal(sessions.sent[0].commandId, `raft-drain:${BINDING_ID}:1`);
    // 活动投影：drain 提交 + 记忆门通过。
    const activity = stack.activity.resolveActivity(BINDING_ID);
    assert.equal(activity?.lastActivityKind, "drain_submitted");
    assert.equal(activity?.memoryLoaded, true);
  });
});

// ── 记忆只读视图边界 ──

test("listMemoryFiles/readMemoryFile：限定记忆面；符号链接与越面路径拒绝；超限截断", async () => {
  await withDataRoot(async (dataRoot) => {
    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.memory.initialize({ bindingId: BINDING_ID, displayName: "t11", homeWorkspacePath: home });
    await mkdir(join(home, "notes"), { recursive: true });
    await writeFile(join(home, "notes", "a.md"), "note-a");
    await mkdir(join(home, "projects"), { recursive: true });
    await writeFile(join(home, "projects", "p.txt"), "project");
    // 符号链接：指向 Home 外的敏感文件。
    const outside = join(dataRoot, "outside-secret.txt");
    await writeFile(outside, "SECRET");
    await symlink(outside, join(home, "notes", "escape.md"));
    await stack.store.writeAll([makeBinding(home, { desiredState: "ReadyStopped", mainSessionRef: null })]);

    const listed = await stack.service.listMemoryFiles(BINDING_ID);
    assert.ok(listed.ok);
    if (listed.ok) {
      const paths = listed.files.map((f) => f.path).sort();
      // 记忆面 = MEMORY.md / AGENTS.md / notes/**；projects/ 与符号链接不在列。
      assert.deepEqual(paths, ["AGENTS.md", "MEMORY.md", "notes/a.md"]);
    }

    // 正常读取。
    const note = await stack.service.readMemoryFile(BINDING_ID, "notes/a.md");
    assert.ok(note.ok && note.content === "note-a" && note.truncated === false);

    // 越面路径与目录穿越在执行边界拒绝。
    for (const bad of ["../outside-secret.txt", "notes/../../outside-secret.txt", "/etc/passwd", "projects/p.txt", "notes/escape.md"]) {
      const denied = await stack.service.readMemoryFile(BINDING_ID, bad);
      assert.equal(denied.ok, false, bad);
      if (!denied.ok) {
        assert.equal(denied.code, bad === "notes/escape.md" ? "OutsideMemorySurface" : "OutsideMemorySurface", bad);
      }
    }
    const missing = await stack.service.readMemoryFile(BINDING_ID, "notes/nope.md");
    assert.deepEqual(missing, { ok: false, code: "NotFound" });

    // 超过 512KB 上限 → 截断并标志。
    const big = join(home, "notes", "big.md");
    await writeFile(big, "x".repeat(600 * 1024));
    const truncated = await stack.service.readMemoryFile(BINDING_ID, "notes/big.md");
    assert.ok(truncated.ok);
    if (truncated.ok) {
      assert.equal(truncated.truncated, true);
      assert.equal(truncated.content.length, 512 * 1024);
    }
    // 未知绑定。
    assert.deepEqual(await stack.service.listMemoryFiles("11111111-2222-4333-8444-555555555555"), {
      ok: false,
      code: "NotFound",
    });
  });
});

// ── 本机凭据枚举 ──

test("listLocalCredentials：非敏感字段 + verify-/坏件跳过 + boundBindingId；apiKey 永不出现", async () => {
  await withDataRoot(async (dataRoot) => {
    const profilesRoot = join(dataRoot, "raft", "profiles");
    const goodSlug = "team-alpha";
    await mkdir(join(profilesRoot, goodSlug), { recursive: true });
    await writeFile(
      join(profilesRoot, goodSlug, "credential.json"),
      JSON.stringify({
        schemaVersion: 1,
        serverUrl: "https://raft.example.com",
        serverId: "srv-1",
        agentId: AGENT_ID,
        agentName: "Team Alpha",
        credentialId: "cred-1",
        scopes: ["agent"],
        apiKey: "sk_agent_secretvalue999",
        createdAt: "2026-09-01T00:00:00Z",
      }),
    );
    await mkdir(join(profilesRoot, "verify-temp1"), { recursive: true });
    await writeFile(
      join(profilesRoot, "verify-temp1", "credential.json"),
      JSON.stringify({ serverUrl: "https://raft.example.com", agentId: AGENT_ID, apiKey: "sk_agent_x" }),
    );
    await mkdir(join(profilesRoot, "broken"), { recursive: true });
    await writeFile(join(profilesRoot, "broken", "credential.json"), "{not json");
    await mkdir(join(profilesRoot, "empty-dir"), { recursive: true });

    const sessions = fakeSessions();
    const supervisor = fakeSupervisor();
    const stack = await buildStack(dataRoot, sessions, supervisor, fakeCli());
    // 一个绑定占用 team-alpha。
    const home = join(dataRoot, "agents", BINDING_ID, "workspace");
    await stack.store.writeAll([makeBinding(home, { profileSlug: goodSlug, desiredState: "ReadyStopped", mainSessionRef: null })]);

    const credentials = await stack.service.listLocalCredentials();
    assert.equal(credentials.length, 1);
    assert.deepEqual(credentials[0], {
      profileSlug: goodSlug,
      serverUrl: "https://raft.example.com",
      serverId: "srv-1",
      agentId: AGENT_ID,
      agentName: "Team Alpha",
      createdAt: "2026-09-01T00:00:00Z",
      boundBindingId: BINDING_ID,
    });
    // 红线：apiKey 不出现在返回结构里。
    assert.equal(JSON.stringify(credentials).includes("sk_agent_"), false);
  });
});

test("resolveProfileToken：Missing / Unreadable / 成功", async () => {
  await withDataRoot(async (dataRoot) => {
    const profilesRoot = join(dataRoot, "raft", "profiles");
    const catalog = createRaftProfilesCatalog(profilesRoot);
    await mkdir(join(profilesRoot, "has-token"), { recursive: true });
    await writeFile(
      join(profilesRoot, "has-token", "credential.json"),
      JSON.stringify({ serverUrl: "https://raft.example.com", agentId: AGENT_ID, apiKey: "sk_agent_reuse123" }),
    );
    await mkdir(join(profilesRoot, "bad-token"), { recursive: true });
    await writeFile(join(profilesRoot, "bad-token", "credential.json"), "null");

    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "no-such" }), { ok: false, code: "Missing" });
    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "bad-token" }), { ok: false, code: "Unreadable" });
    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "../evil" }), { ok: false, code: "Unreadable" });
    const ok = await catalog.resolveProfileToken({ profileSlug: "has-token" });
    assert.deepEqual(ok, { ok: true, token: "sk_agent_reuse123" });
  });
});

// ── 凭据预核验 ──

test("verifyCredential：成功返回身份且临时 profile 全路径即毁", async () => {
  await withDataRoot(async (dataRoot) => {
    const cli = fakeCli();
    const service = createRaftAgentsService({
      cli,
      store: createRaftBindingStore(dataRoot),
      clock: fixedClock,
      dataRootDir: dataRoot,
    });
    const result = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_preflightok1",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.identity, {
      agentId: AGENT_ID,
      agentName: "Fake Agent",
      serverUrl: "https://raft.example.com",
      serverId: "server-1",
    });
    // 留空 → 预派发默认路径：数据根 agents/<uuid>/workspace（与创建同一派生函数）。
    assert.ok(result.homePath.startsWith(join(dataRoot, "agents")));
    assert.match(
      result.homePath,
      /agents[/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[/]workspace$/,
    );
    // 临时 profile 用 verify- 前缀且被销毁；本机凭据枚举不包含它。
    assert.equal(cli.loginCalls.length, 1);
    assert.match(cli.loginCalls[0].profileSlug, /^verify-/);
    assert.equal(cli.destroyCalls.length, 1);
    assert.match(cli.destroyCalls[0], /verify-/);
    assert.equal((await service.listLocalCredentials()).length, 0);
  });
});

test("verifyCredential：homePath 输入回显 / 形状非法本地拒收", async () => {
  await withDataRoot(async (dataRoot) => {
    const cli = fakeCli();
    const service = createRaftAgentsService({
      cli,
      store: createRaftBindingStore(dataRoot),
      clock: fixedClock,
      dataRootDir: dataRoot,
    });
    // 输入给了就原样回显（确认页显示实际生效路径）。
    const echoed = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_preflightok1",
      homeWorkspacePath: "/tmp/raft-custom-home",
    });
    assert.equal(echoed.ok, true);
    if (echoed.ok) assert.equal(echoed.homePath, "/tmp/raft-custom-home");

    // 相对路径在本地快速拒收（与创建的 homePath 形状规则一致），不动 CLI、不建 profile。
    const bad = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_preflightok1",
      homeWorkspacePath: "relative/not-absolute",
    });
    assert.deepEqual(bad, {
      ok: false,
      code: "OriginInvalid",
      detail: "homeWorkspacePath must be an absolute path",
    });
    // 形状非法在本地快速拒收：login 只有前一次回显成功，坏路径没有产生新登录。
    assert.equal(cli.loginCalls.length, 1);
  });
});

test("verifyCredential：同源同 agent 已接入 → AlreadyBound 定向提示且不发起登录（预核验早失败）", async () => {
  await withDataRoot(async (dataRoot) => {
    const cli = fakeCli();
    const store = createRaftBindingStore(dataRoot);
    await store.writeAll([makeBinding(join(dataRoot, "agents", "b1", "workspace"))]);
    const service = createRaftAgentsService({
      cli,
      store,
      clock: fixedClock,
      dataRootDir: dataRoot,
    });
    const result = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_preflightok1",
    });
    // 确认页直接看到"已接入（占用者）"，不再走到保存才暴露；登录未发起。
    assert.deepEqual(result, { ok: false, code: "AlreadyBound", detail: "t11-test-agent" });
    assert.equal(cli.loginCalls.length, 0, "第一层判定先于登录，零网络副作用");
  });
});

test("verifyCredential：域名不同但同 serverId+agentId → 登录核验后命中 AlreadyBound", async () => {
  await withDataRoot(async (dataRoot) => {
    const cli = fakeCli();
    const store = createRaftBindingStore(dataRoot);
    // 既有绑定来自另一域名形态（第一层同源判定不命中），serverId 与核验结果相同。
    await store.writeAll([
      makeBinding(join(dataRoot, "agents", "b1", "workspace"), {
        raftOrigin: "https://alias.raft.example.com",
        serverId: "server-1",
      }),
    ]);
    const service = createRaftAgentsService({
      cli,
      store,
      clock: fixedClock,
      dataRootDir: dataRoot,
    });
    const result = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_preflightok1",
    });
    assert.deepEqual(result, { ok: false, code: "AlreadyBound", detail: "t11-test-agent" });
    assert.equal(cli.loginCalls.length, 1, "第二层在登录核验之后，临时 profile 照常即毁");
  });
});

test("verifyCredential：复用已有凭据——读 token 走同一核验链，用户 profile 不被触碰", async () => {
  await withDataRoot(async (dataRoot) => {
    const profilesRoot = join(dataRoot, "raft", "profiles");
    await mkdir(join(profilesRoot, "team-alpha"), { recursive: true });
    const credentialJson = JSON.stringify({
      serverUrl: "https://raft.example.com",
      agentId: AGENT_ID,
      apiKey: "sk_agent_reuse123",
    });
    const credPath = join(profilesRoot, "team-alpha", "credential.json");
    await writeFile(credPath, credentialJson);
    const cli = fakeCli();
    const service = createRaftAgentsService({
      cli,
      store: createRaftBindingStore(dataRoot),
      clock: fixedClock,
      dataRootDir: dataRoot,
      profilesCatalog: createRaftProfilesCatalog(profilesRoot),
    });
    const result = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      existingProfileSlug: "team-alpha",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.identity.agentId, AGENT_ID);
      assert.ok(result.homePath.startsWith(join(dataRoot, "agents")));
    }
    // 读出的 token 直达 CLI stdin；核验走临时 verify- profile（与直传同一条链）。
    assert.equal(cli.loginCalls.length, 1);
    assert.equal(cli.loginCalls[0].token, "sk_agent_reuse123");
    assert.match(cli.loginCalls[0].profileSlug, /^verify-/);
    assert.equal(cli.destroyCalls.length, 1);
    // 用户 profile 原样保留，无 verify- 残留。
    assert.equal(await readFile(credPath, "utf8"), credentialJson);
    assert.deepEqual(await readdir(profilesRoot), ["team-alpha"]);
  });
});

test("verifyCredential：复用被占用凭据 → ProfileInUse；读不出 → CredentialCheckFailed", async () => {
  await withDataRoot(async (dataRoot) => {
    const profilesRoot = join(dataRoot, "raft", "profiles");
    await mkdir(join(profilesRoot, "team-alpha"), { recursive: true });
    await writeFile(
      join(profilesRoot, "team-alpha", "credential.json"),
      JSON.stringify({ serverUrl: "https://raft.example.com", agentId: AGENT_ID, apiKey: "sk_agent_reuse123" }),
    );
    const cli = fakeCli();
    const store = createRaftBindingStore(dataRoot);
    // 已有绑定占用 team-alpha。
    await store.writeAll([
      makeBinding(join(dataRoot, "agents", BINDING_ID, "workspace"), {
        bindingId: "12345678-1234-4123-8123-123456789012",
        profileSlug: "team-alpha",
        desiredState: "ReadyStopped",
        mainSessionRef: null,
      }),
    ]);
    const service = createRaftAgentsService({
      cli,
      store,
      clock: fixedClock,
      dataRootDir: dataRoot,
      profilesCatalog: createRaftProfilesCatalog(profilesRoot),
    });
    // 占用早失败（与 createBinding 同款），确认页不该走到保存才报。
    assert.deepEqual(
      await service.verifyCredential({
        raftOrigin: "https://raft.example.com",
        raftAgentId: AGENT_ID,
        existingProfileSlug: "team-alpha",
      }),
      { ok: false, code: "ProfileInUse", detail: "t11-test-agent" },
    );
    // 读不出的 slug（不存在）→ CredentialCheckFailed，且未触达 login。
    assert.deepEqual(
      await service.verifyCredential({
        raftOrigin: "https://raft.example.com",
        raftAgentId: AGENT_ID,
        existingProfileSlug: "ghost",
      }),
      { ok: false, code: "CredentialCheckFailed", detail: "Missing" },
    );
    assert.equal(cli.loginCalls.length, 0);
  });
});

test("verifyCredential：身份不一致 → IdentityMismatch 且销毁临时 profile", async () => {
  await withDataRoot(async (dataRoot) => {
    const cli = fakeCli();
    cli.whoami = async () => ({
      agentId: "00000000-0000-0000-0000-000000000000",
      serverUrl: "https://raft.example.com",
      serverId: "server-1",
    });
    const service = createRaftAgentsService({
      cli,
      store: createRaftBindingStore(dataRoot),
      clock: fixedClock,
      dataRootDir: dataRoot,
    });
    const result = await service.verifyCredential({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_somebodyelse",
    });
    assert.deepEqual(result, { ok: false, code: "IdentityMismatch" });
    assert.equal(cli.destroyCalls.length, 1);
  });
});

// ── 复用凭据接入 ──

test("createBinding 复用已有凭据：token 从 profile 读取走同一链路，绑定用自己的 slug", async () => {
  await withDataRoot(async (dataRoot) => {
    const profilesRoot = join(dataRoot, "raft", "profiles");
    await mkdir(join(profilesRoot, "team-alpha"), { recursive: true });
    await writeFile(
      join(profilesRoot, "team-alpha", "credential.json"),
      JSON.stringify({ serverUrl: "https://raft.example.com", agentId: AGENT_ID, apiKey: "sk_agent_reuse123" }),
    );
    const cli = fakeCli();
    const service = createRaftAgentsService({
      cli,
      store: createRaftBindingStore(dataRoot),
      clock: fixedClock,
      dataRootDir: dataRoot,
      profilesCatalog: createRaftProfilesCatalog(profilesRoot),
    });
    const result = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      existingProfileSlug: "team-alpha",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      // token 经 login 参数直达 stdin（CLI 假件收到的是 profile 里的值）。
      assert.equal(cli.loginCalls.length, 1);
      assert.equal(cli.loginCalls[0].token, "sk_agent_reuse123");
      // 绑定不占用源 profile：slug 是 ZCode 生成的。
      assert.notEqual(result.binding.profileSlug, "team-alpha");
    }
  });
});

test("createBinding 复用被占用凭据 → ProfileInUse；读不出 → CredentialCheckFailed", async () => {
  await withDataRoot(async (dataRoot) => {
    const profilesRoot = join(dataRoot, "raft", "profiles");
    await mkdir(join(profilesRoot, "team-alpha"), { recursive: true });
    await writeFile(
      join(profilesRoot, "team-alpha", "credential.json"),
      JSON.stringify({ serverUrl: "https://raft.example.com", agentId: AGENT_ID, apiKey: "sk_agent_reuse123" }),
    );
    const cli = fakeCli();
    const store = createRaftBindingStore(dataRoot);
    // 已有绑定占用 team-alpha。
    await store.writeAll([
      makeBinding(join(dataRoot, "agents", BINDING_ID, "workspace"), {
        bindingId: "12345678-1234-4123-8123-123456789012",
        profileSlug: "team-alpha",
        desiredState: "ReadyStopped",
        mainSessionRef: null,
      }),
    ]);
    const service = createRaftAgentsService({
      cli,
      store,
      clock: fixedClock,
      dataRootDir: dataRoot,
      profilesCatalog: createRaftProfilesCatalog(profilesRoot),
    });
    assert.deepEqual(
      await service.createBinding({
        raftOrigin: "https://raft.example.com",
        raftAgentId: AGENT_ID,
        existingProfileSlug: "team-alpha",
      }),
      { ok: false, code: "ProfileInUse", detail: "t11-test-agent" },
    );
    // 读不出的 slug（不存在）→ CredentialCheckFailed，且未触达 login。
    assert.deepEqual(
      await service.createBinding({
        raftOrigin: "https://raft.example.com",
        raftAgentId: AGENT_ID,
        existingProfileSlug: "ghost",
      }),
      { ok: false, code: "CredentialCheckFailed", detail: "Missing" },
    );
    assert.equal(cli.loginCalls.length, 0);
  });
});
