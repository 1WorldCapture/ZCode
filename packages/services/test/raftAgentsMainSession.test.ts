/**
 * 主会话 provisioning 步骤测试：幂等跳过、fail-closed（插件不可用不建会话）、
 * 变异写回 mainSessionRef（代次 1）、MCP 配置透传、适配器 createAgentSession 映射。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { RaftAgentBinding, ZCodeAgentMcpServer } from "@zcode/shared";

import { createMainSessionProvisioningStep } from "../src/raft-agents/app/mainSessionProvisioning.js";
import type { RaftSessionPort } from "../src/raft-agents/app/ports.js";
import { createZcodeSessionPort } from "../src/raft-agents/adapters/zcodeSession.js";
import type { ZcodeSessionAgent } from "../src/raft-agents/adapters/zcodeSession.js";

const BINDING_ID = "99999999-8888-4777-a666-555555555555";

const MCP_SERVERS: ZCodeAgentMcpServer[] = [
  {
    name: "raft_agent_tools",
    command: "/fake/electron",
    args: ["--prefix", "/plugins/raft-agent-tools/dist/mcp/server.js"],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "RAFT_PROFILE_DIR", value: "/tmp/profiles/agent-a" },
    ],
    isolation: "session",
    protocolVersion: "2026-07-28",
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
    mcpServers: ZCodeAgentMcpServer[];
  }[] = [];
  const port: RaftSessionPort = {
    async sendQueuedText() {
      throw new Error("本测试不触发送路径");
    },
    async createAgentSession(params) {
      calls.push({ workspacePath: params.workspacePath, mcpServers: params.mcpServers });
      return created.ok ? { ok: true, sessionId: created.sessionId } : { ok: false, code: "failed", detail: created.detail };
    },
  };
  return { port, calls };
}

test("创建空主会话：变异写回 mainSessionRef（代次 1），MCP 配置原样透传", async () => {
  const { port, calls } = fakeSessions({ ok: true, sessionId: "sess-new" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveMcpServers: async () => MCP_SERVERS,
  });
  const binding = makeBinding();
  await step.execute(binding);
  assert.deepEqual(binding.mainSessionRef, { sessionId: "sess-new", sessionGeneration: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspacePath, "/tmp/raft-homes/agent-a");
  assert.deepEqual(calls[0].mcpServers, MCP_SERVERS);
  assert.equal(calls[0].mcpServers[0].isolation, "session");
  assert.equal(calls[0].mcpServers[0].protocolVersion, "2026-07-28");
  assert.equal(step.name, "main-session");
});

test("幂等：mainSessionRef 已存在即跳过，不触会话创建", async () => {
  const { port, calls } = fakeSessions({ ok: true, sessionId: "sess-x" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveMcpServers: async () => MCP_SERVERS,
  });
  const binding = makeBinding({ mainSessionRef: { sessionId: "sess-old", sessionGeneration: 4 } });
  await step.execute(binding);
  assert.deepEqual(binding.mainSessionRef, { sessionId: "sess-old", sessionGeneration: 4 });
  assert.equal(calls.length, 0);
});

test("fail-closed：MCP 配置不可用（undefined/空）直接失败，不建会话", async () => {
  const { port, calls } = fakeSessions({ ok: true, sessionId: "sess-x" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveMcpServers: async () => undefined,
  });
  const binding = makeBinding();
  await assert.rejects(() => step.execute(binding), /MCP config unavailable/);
  assert.equal(binding.mainSessionRef, null, "失败不写回");
  assert.equal(calls.length, 0);

  const emptyStep = createMainSessionProvisioningStep({
    sessions: port,
    resolveMcpServers: async () => [],
  });
  await assert.rejects(() => emptyStep.execute(makeBinding()), /MCP config unavailable/);
});

test("会话创建失败向上抛（服务层映射 ProvisioningFailed，可重试）", async () => {
  const { port } = fakeSessions({ ok: false, detail: "rpc down" });
  const step = createMainSessionProvisioningStep({
    sessions: port,
    resolveMcpServers: async () => MCP_SERVERS,
  });
  const binding = makeBinding();
  await assert.rejects(() => step.execute(binding), /createAgentSession failed: rpc down/);
  assert.equal(binding.mainSessionRef, null);
});

test("zcodeSession 适配器 createAgentSession：session/create 通道 + 异常映射", async () => {
  const created: { workspacePath: string; mcpServers: ZCodeAgentMcpServer[] }[] = [];
  const agent: ZcodeSessionAgent = {
    async sendConversationCommandV4() {
      throw new Error("不应触发送路径");
    },
    async createSession(params) {
      created.push({ workspacePath: params.workspacePath, mcpServers: params.mcpServers ?? [] });
      return { session: { sessionId: "sess-42" } };
    },
  };
  const port = createZcodeSessionPort(agent);
  const outcome = await port.createAgentSession({
    workspacePath: "/tmp/wh",
    mcpServers: MCP_SERVERS,
  });
  assert.deepEqual(outcome, { ok: true, sessionId: "sess-42" });
  assert.equal(created[0].workspacePath, "/tmp/wh");
  assert.deepEqual(created[0].mcpServers, MCP_SERVERS);

  const failing: ZcodeSessionAgent = {
    ...agent,
    async createSession() {
      throw new Error("workspace client unavailable");
    },
  };
  const failed = await createZcodeSessionPort(failing).createAgentSession({
    workspacePath: "/tmp/wh",
    mcpServers: MCP_SERVERS,
  });
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.detail?.includes("workspace client unavailable"));
});
