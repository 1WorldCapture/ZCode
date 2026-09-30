/**
 * 唤醒投递（wakeDelivery + zcodeSession 适配器）测试。
 * 覆盖：会话就绪判定、commandId 确定性（幂等键）、drain 文本来源头、
 * ACK 六态映射、退避建议（busy）与 noSession/injectionFailed 分支。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { RaftAgentBinding } from "@zcode/shared";

import { buildWakePrompt, createRaftWakeDelivery, wakeCycleId } from "../src/raft-agents/app/wakeDelivery.js";
import type { RaftBindingStorePort, RaftSessionPort, RaftSessionSendOutcome } from "../src/raft-agents/app/ports.js";
import type { RaftWakeRequest, WakeDelivery } from "../src/raft-agents/app/ports.js";
import { createZcodeSessionPort } from "../src/raft-agents/adapters/zcodeSession.js";
import type { CommandEnvelope } from "@zcode/shared";

const BINDING_ID = "99999999-8888-4777-a666-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makeBinding(overrides: Partial<RaftAgentBinding> = {}): RaftAgentBinding {
  return {
    bindingId: BINDING_ID,
    displayName: "t0-test-agent",
    raftOrigin: "https://raft.example.com",
    serverId: "srv-1",
    raftAgentId: AGENT_ID,
    profileSlug: "t0-test-agent",
    homeWorkspacePath: "/tmp/raft-homes/agent-a",
    mainSessionRef: { sessionId: "sess-7", sessionGeneration: 3 },
    desiredState: "Running",
    autostartConsent: false,
    adapterInstance: BINDING_ID,
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

function makeWake(overrides: Partial<RaftWakeRequest> = {}): RaftWakeRequest {
  return {
    schema: "raft-channel-wake.v1",
    attemptId: "att-9",
    eventId: "evt-9",
    messageId: "msg-9",
    agentId: AGENT_ID,
    profile: "t0-test-agent",
    coreSessionId: "core-1",
    adapterInstance: BINDING_ID,
    occurredAt: "2026-09-30T08:00:00Z",
    ...overrides,
  };
}

function fakeStore(bindings: RaftAgentBinding[]): RaftBindingStorePort {
  return {
    async readAll() {
      return bindings;
    },
    async writeAll() {
      throw new Error("wake delivery 不写 store");
    },
  };
}

interface SentCall {
  workspacePath: string;
  sessionId: string;
  commandId: string;
  text: string;
}

/** 可编程 sessions 端口：记录调用并按脚本返回。 */
function fakeSessions(scripts: RaftSessionSendOutcome[] = [{ ok: true, duplicate: false }]) {
  const sent: SentCall[] = [];
  let i = 0;
  const port: RaftSessionPort = {
    async sendQueuedText(params) {
      sent.push(params);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i += 1;
      return script;
    },
  };
  return { port, sent };
}

test("accepted：runtimeSession 为代次标识，参数含 queue 文本与确定性 commandId", async () => {
  const { port, sent } = fakeSessions();
  const handler = createRaftWakeDelivery({ store: fakeStore([makeBinding()]), sessions: port });
  const delivery = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.deepEqual(delivery, { kind: "accepted", runtimeSession: "3" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].workspacePath, "/tmp/raft-homes/agent-a");
  assert.equal(sent[0].sessionId, "sess-7");
  assert.equal(sent[0].commandId, wakeCycleId(BINDING_ID, "msg-9"));
  const text = sent[0].text;
  assert.ok(text.includes("msg-9"), "drain 文本含 messageId 来源头");
  assert.ok(text.includes("2026-09-30T08:00:00Z"), "drain 文本含时间来源头");
  assert.ok(text.includes("raft_message_check"), "引导走收件工具");
  assert.ok(!text.includes("sk_agent_"), "无凭据形态");
});

test("幂等键稳定：同一 messageId 重复唤醒派生同一 commandId；duplicate 仍 accepted", async () => {
  const { port, sent } = fakeSessions([{ ok: true, duplicate: false }, { ok: true, duplicate: true }]);
  const handler = createRaftWakeDelivery({ store: fakeStore([makeBinding()]), sessions: port });
  const first = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  const retry = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake({ attemptId: "att-10" }) });
  assert.deepEqual(first, { kind: "accepted", runtimeSession: "3" });
  assert.deepEqual(retry, { kind: "accepted", runtimeSession: "3" });
  assert.equal(sent[0].commandId, sent[1].commandId);
  assert.ok(wakeCycleId(BINDING_ID, "msg-9").startsWith("raft-wake:"));
});

test("noSession：绑定不存在 / 无主会话 / 非值守态", async () => {
  const { port, sent } = fakeSessions();
  const cases: RaftAgentBinding[] = [
    makeBinding({ mainSessionRef: null }),
    makeBinding({ desiredState: "ReadyStopped" }),
  ];
  for (const binding of cases) {
    const handler = createRaftWakeDelivery({ store: fakeStore([binding]), sessions: port });
    const delivery = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
    assert.deepEqual(delivery, { kind: "noSession" });
  }
  const missing = createRaftWakeDelivery({ store: fakeStore([]), sessions: port });
  assert.deepEqual(await missing.handleWake({ bindingId: BINDING_ID, wake: makeWake() }), {
    kind: "noSession",
  });
  assert.equal(sent.length, 0, "未就绪时不提交任何命令");
});

test("分支映射：noSession→noSession、transport→busy(退避)、rejected→injectionFailed", async () => {
  const scripts: RaftSessionSendOutcome[] = [
    { ok: false, code: "noSession", detail: "stale" },
    { ok: false, code: "transport", detail: "rpc down" },
    { ok: false, code: "rejected", detail: "fault.command.inputRejected" },
  ];
  const { port } = fakeSessions(scripts);
  const handler = createRaftWakeDelivery({
    store: fakeStore([makeBinding()]),
    sessions: port,
    busyRetryAfterMs: 2_500,
  });
  const results: WakeDelivery[] = [];
  for (let i = 0; i < scripts.length; i += 1) {
    results.push(await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() }));
  }
  assert.deepEqual(results[0], { kind: "noSession" });
  assert.deepEqual(results[1], { kind: "busy", retryAfterMs: 2_500 });
  assert.deepEqual(results[2], { kind: "injectionFailed", detail: "fault.command.inputRejected" });
});

function ack(status: CommandAck["status"], extra: Partial<CommandAck> = {}): CommandAck {
  return { commandId: "c1", status, revisionAtDecision: 1, ...extra };
}

/** 记录 envelope 的假 agent，供适配器测试。 */
function fakeAgent(acks: CommandAck[] | ((envelope: CommandEnvelope) => CommandAck)) {
  const envelopes: CommandEnvelope[] = [];
  let i = 0;
  return {
    envelopes,
    async sendConversationCommandV4(params: { envelope: CommandEnvelope }): Promise<CommandAck> {
      envelopes.push(params.envelope);
      const next = typeof acks === "function" ? acks(params.envelope) : acks[Math.min(i, acks.length - 1)];
      i += 1;
      return next;
    },
  };
}

test("zcodeSession 适配器：ACK 六态映射 + requestedDelivery queue + commandId 透传", async () => {
  const agent = fakeAgent([
    ack("accepted"),
    ack("duplicate"),
    ack("noop"),
    ack("stale", { reasonCode: "session_gone" }),
    ack("failed", { reasonCode: "fault.runtime.dead" }),
    ack("rejected", { reasonCode: "fault.command.inputRejected" }),
  ]);
  const port = createZcodeSessionPort(agent);
  const outcomes = [];
  for (let i = 0; i < 6; i += 1) {
    outcomes.push(
      await port.sendQueuedText({
        workspacePath: "/tmp/wh",
        sessionId: "sess-7",
        commandId: `cmd-${i}`,
        text: "t",
      }),
    );
  }
  assert.deepEqual(outcomes[0], { ok: true, duplicate: false });
  assert.deepEqual(outcomes[1], { ok: true, duplicate: true });
  assert.deepEqual(outcomes[2], { ok: true, duplicate: false });
  assert.deepEqual(outcomes[3], { ok: false, code: "noSession", detail: "session_gone" });
  assert.deepEqual(outcomes[4], { ok: false, code: "transport", detail: "fault.runtime.dead" });
  assert.deepEqual(outcomes[5], { ok: false, code: "rejected", detail: "fault.command.inputRejected" });

  // envelope 形态：sendText + queue + 显式 commandId/sessionId（幂等与目标会话都在调用方控制）。
  const first = agent.envelopes[0] as unknown as {
    type: string;
    sessionId: string | null;
    commandId: string;
    payload: { requestedDelivery?: string; text: string };
  };
  assert.equal(first.type, "sendText");
  assert.equal(first.sessionId, "sess-7");
  assert.equal(first.commandId, "cmd-0");
  assert.equal(first.payload.requestedDelivery, "queue");
  assert.equal(first.payload.text, "t");
});

test("zcodeSession 适配器：RPC 抛异常按 transport（可退避重试）", async () => {
  const agent = {
    async sendConversationCommandV4(): Promise<CommandAck> {
      throw new Error("connection closed");
    },
  };
  const port = createZcodeSessionPort(agent);
  const outcome = await port.sendQueuedText({
    workspacePath: "/tmp/wh",
    sessionId: "s",
    commandId: "c",
    text: "t",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, "transport");
});

test("buildWakePrompt：只含来源头与工具引导，不含消息正文", () => {
  const text = buildWakePrompt(makeWake());
  assert.ok(text.includes("messageId=msg-9"));
  assert.ok(text.includes("eventId=evt-9"));
  assert.ok(text.includes(BINDING_ID), "含适配实例标识");
  assert.ok(text.includes("raft_message_send"));
});
