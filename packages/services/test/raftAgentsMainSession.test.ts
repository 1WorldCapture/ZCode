/**
 * 主会话 provisioning 步骤测试：幂等跳过、fail-closed（插件不可用不建会话）、
 * 变异写回 mainSessionRef（代次 1）、官方 MCP 引用与 agentMemory 透传、
 * 适配器 create/resume 映射。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { RaftAgentBinding, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import { createMainSessionProvisioningStep } from "../src/raft-agents/app/mainSessionProvisioning.js";
import type { RaftSessionPort } from "../src/raft-agents/app/ports.js";
import { createZcodeSessionPort } from "../src/raft-agents/adapters/zcodeSession.js";
import type { ZcodeSessionAgent } from "../src/raft-agents/adapters/zcodeSession.js";

const BINDING_ID = "99999999-8888-4777-a666-555555555555";

/** 宿主解析产物形态：具名引用 + ZCODE_RAFT_* env（无 command/args/isolation——app-server 拼装并锁定）。 */
const MCP_REFS: ZCodeOfficialMcpServerRef[] = [
  {
    name: "raft-agent-tools",
    env: [
      { name: "ZCODE_RAFT_BINDING_ID", value: BINDING_ID },
      { name: "ZCODE_RAFT_PROFILE_SLUG", value: "agent-a" },
    ],
  },
];

function makeBinding(overrides: Partial<RaftAgentBinding> = {}): RaftAgentBinding {
  return {
    bindingId: BINDING_ID,
    displayName: "agent-a",
    raftOrigin: "https://raft.example.com",
    serverId: "srv-1",
    raftAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    profileSlug: "agent-a",
    homeWorkspacePath: "/tmp/raft-homes/agent-a",
    mainSessionRef: null,
    desiredState: "ReadyStopped",
    autostartConsent: false,
    adapterInstance: BINDING_ID,
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

function fakeSessions(created: { ok: true; sessionId: string } | { ok: false; detail?: string }) {
  const calls: {
    workspacePath: string;
    agentMemory: { homeRoot: string; agentName?: string };
    officialMcpServers: ZCodeOfficialMcpServerRef[];
  }[] = [];
  const port: RaftSessionPort = {
    async sendQueuedText() {
      throw new Error("本测试不触发送路径");
    },
    async resumeAgentSession() {
      throw new Error("本测试不触恢复路径");
    },
    async createAgentSession(params) {
      calls.push({
        workspacePath: params.workspacePath,
        agentMemory: params.agentMemory,
        officialMcpServers: params.officialMcpServers,
      });
      return created.ok ? { ok: true, sessionId: created.sessionId } : { ok: false, code: "failed", detail: created.detail };
    },
  };
  return { port, calls };
}

test("创建空主会话：变异写回 mainSessionRef（代次 1），官方 MCP 引用与记忆作用域透传", async () => {
  const { port, calls } = fakeSessions({ ok: true, sessionId: "sess-new" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveOfficialMcpServers: async () => MCP_REFS,
  });
  const binding = makeBinding();
  await step.execute(binding);
  assert.deepEqual(binding.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspacePath, "/tmp/raft-homes/agent-a");
  // 记忆作用域 = Agent Home；agentName 用绑定显示名。
  assert.equal(calls[0].agentMemory.homeRoot, "/tmp/raft-homes/agent-a");
  assert.equal(calls[0].agentMemory.agentName, "agent-a");
  // 官方引用原样透传（command/isolation/protocolVersion 由 app-server 锁定，宿主不出现）。
  assert.deepEqual(calls[0].officialMcpServers, MCP_REFS);
  assert.equal(step.name, "main-session");
});

test("幂等：mainSessionRef 已存在即跳过，不触会话创建", async () => {
  const { port, calls } = fakeSessions({ ok: true, sessionId: "sess-x" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveOfficialMcpServers: async () => MCP_REFS,
  });
  const binding = makeBinding({ mainSessionRef: { sessionId: "sess-old", sessionGeneration: 4 } });
  await step.execute(binding);
  assert.deepEqual(binding.mainSessionRef, { sessionId: "sess-old", sessionGeneration: 4 });
  assert.equal(calls.length, 0);
});

test("fail-closed：官方 MCP 引用不可用（undefined/空）直接失败，不建会话", async () => {
  const { port, calls } = fakeSessions({ ok: true, sessionId: "sess-x" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveOfficialMcpServers: async () => undefined,
  });
  const binding = makeBinding();
  await assert.rejects(() => step.execute(binding), /MCP config unavailable/);
  assert.equal(binding.mainSessionRef, null, "失败不写回");
  assert.equal(calls.length, 0);

  const emptyStep = createMainSessionProvisioningStep({
    sessions: port,
    resolveOfficialMcpServers: async () => [],
  });
  await assert.rejects(() => emptyStep.execute(makeBinding()), /MCP config unavailable/);
});

test("会话创建失败向上抛（服务层映射 ProvisioningFailed，可重试）", async () => {
  const { port } = fakeSessions({ ok: false, detail: "rpc down" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveOfficialMcpServers: async () => MCP_REFS,
  });
  const binding = makeBinding();
  await assert.rejects(() => step.execute(binding), /createAgentSession failed: rpc down/);
  assert.equal(binding.mainSessionRef, null);
});

test("zcodeSession 适配器 create/resume：session 通道透传 agentMemory + officialMcpServers + 异常映射", async () => {
  const created: {
    workspacePath: string;
    agentMemory?: { homeRoot: string; agentName?: string };
    officialMcpServers?: ZCodeOfficialMcpServerRef[];
    persistence?: string;
    mode?: string;
    toolAllowlist?: readonly string[];
    confineFileToolsToWorkspace?: boolean;
  }[] = [];
  const resumed: {
    workspacePath: string;
    sessionId: string;
    agentMemory?: { homeRoot: string; agentName?: string };
    officialMcpServers?: ZCodeOfficialMcpServerRef[];
    toolAllowlist?: readonly string[];
    confineFileToolsToWorkspace?: boolean;
  }[] = [];
  const agent: ZcodeSessionAgent = {
    async sendConversationCommandV4() {
      throw new Error("不应触发送路径");
    },
    async createSession(params) {
      created.push({
        workspacePath: params.workspacePath,
        agentMemory: params.agentMemory,
        officialMcpServers: params.officialMcpServers,
        persistence: params.persistence,
        mode: params.mode,
        toolAllowlist: params.toolAllowlist,
        confineFileToolsToWorkspace: params.confineFileToolsToWorkspace,
      });
      return { session: { sessionId: "sess-42" } };
    },
    async resumeSession(params) {
      resumed.push({
        workspacePath: params.workspacePath,
        sessionId: params.sessionId,
        agentMemory: params.agentMemory,
        officialMcpServers: params.officialMcpServers,
        toolAllowlist: params.toolAllowlist,
        confineFileToolsToWorkspace: params.confineFileToolsToWorkspace,
      });
      return {};
    },
  };
  const port = createZcodeSessionPort(agent);
  const agentMemory = { homeRoot: "/tmp/wh", agentName: "agent-a" };
  const outcome = await port.createAgentSession({
    workspacePath: "/tmp/wh",
    agentMemory,
    officialMcpServers: MCP_REFS,
  });
  assert.deepEqual(outcome, { ok: true, sessionId: "sess-42" });
  assert.equal(created[0].workspacePath, "/tmp/wh");
  assert.deepEqual(created[0].agentMemory, agentMemory);
  assert.deepEqual(created[0].officialMcpServers, MCP_REFS);
  // deferred 草稿创建：首个输入（V4 drain/wake）的统一持久化边界才写 session 行；
  // 缺省 immediate 会让 V4 durable admission 跳过该边界 → session_input 外键失败（e2e S4）。
  assert.equal(created[0].persistence, "deferred");
  // 无人值守权限模型（e2e S4 第五层）：yolo 全自动 + 工具白名单 + 文件工具锁定 workspace。
  assert.equal(created[0].mode, "yolo");
  assert.ok(created[0].toolAllowlist?.includes("mcp__raft_agent_tools__raft_message_check"));
  assert.ok(!created[0].toolAllowlist?.includes("Bash"));
  assert.ok(!created[0].toolAllowlist?.includes("ApplyPatch"));
  assert.equal(created[0].confineFileToolsToWorkspace, true);

  const resumeOutcome = await port.resumeAgentSession({
    workspacePath: "/tmp/wh",
    sessionId: "sess-42",
    agentMemory,
    officialMcpServers: MCP_REFS,
  });
  assert.deepEqual(resumeOutcome, { ok: true });
  assert.equal(resumed[0].sessionId, "sess-42");
  assert.deepEqual(resumed[0].agentMemory, agentMemory);
  assert.deepEqual(resumed[0].officialMcpServers, MCP_REFS);
  // resume 重发工具面与文件边界（mode 由协议侧从持久化状态派生，不随 resume 传）。
  assert.deepEqual(resumed[0].toolAllowlist, created[0].toolAllowlist);
  assert.equal(resumed[0].confineFileToolsToWorkspace, true);

  const failing: ZcodeSessionAgent = {
    ...agent,
    async createSession() {
      throw new Error("workspace client unavailable");
    },
    async resumeSession() {
      throw new Error("resume rpc down");
    },
  };
  const failingPort = createZcodeSessionPort(failing);
  const failed = await failingPort.createAgentSession({
    workspacePath: "/tmp/wh",
    agentMemory,
    officialMcpServers: MCP_REFS,
  });
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.detail?.includes("workspace client unavailable"));
  const resumeFailed = await failingPort.resumeAgentSession({
    workspacePath: "/tmp/wh",
    sessionId: "sess-42",
    agentMemory,
    officialMcpServers: MCP_REFS,
  });
  assert.ok(!resumeFailed.ok && resumeFailed.detail?.includes("resume rpc down"));
});
