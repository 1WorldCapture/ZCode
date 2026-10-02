// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 唤醒投递（wakeDelivery + zcodeSession 适配器）测试。
 * 覆盖：会话就绪判定、commandId 确定性（幂等键）、targetLost 自愈（resume 一次/失败置暂停/最小装配回退）、drain 文本来源头、
 * 拒绝三态映射（经任务门面）、退避建议（busy）与 noSession/injectionFailed 分支。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { RaftAgentBinding } from "@zcode/shared";

import { buildWakePrompt, wakeCycleId } from "../src/raft-agents/app/prompts.js";
import { createRaftWakeDelivery } from "../src/raft-agents/app/wakeDelivery.js";
import type { RaftBindingStorePort, RaftSessionPort, RaftSessionSendOutcome } from "../src/raft-agents/app/ports.js";
import type { RaftWakeRequest, WakeDelivery } from "../src/raft-agents/app/ports.js";
import { createZcodeSessionPort } from "../src/raft-agents/adapters/zcodeSession.js";
import { ZCodeV4CommandRejectedError } from "../src/zcode-agent/zcodeV4HostCommand.js";

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

/**
 * 可编程 sessions 端口：记录调用并按脚本返回；resume 走 targetLost 自愈路径，
 * 由测试注入结果（缺省抛错 = 该测试不应触自愈）。
 */
function fakeSessions(
  scripts: RaftSessionSendOutcome[] = [{ ok: true, duplicate: false }],
  resume?: { ok: true } | { ok: false; detail?: string },
) {
  const sent: SentCall[] = [];
  const resumes: unknown[] = [];
  let i = 0;
  const port: RaftSessionPort = {
    async sendQueuedText(params) {
      sent.push(params);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i += 1;
      return script;
    },
    async createAgentSession() {
      throw new Error("唤醒投递不建会话");
    },
    async resumeAgentSession(params) {
      resumes.push(params);
      if (!resume) throw new Error("本测试未配置自愈 resume");
      if (resume.ok) return { ok: true as const };
      return { ok: false as const, code: "failed" as const, detail: resume.detail };
    },
  };
  return { port, sent, resumes };
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

/** 记录参数的假任务门面：sendPrompt 按脚本成功或抛结构化拒绝，供适配器测试。 */
function fakeTaskService(
  scripts: Array<
    | { kind: "ok" }
    | { kind: "reject"; ack: CommandAck }
    | { kind: "throw"; error: Error }
  >,
) {
  const prompts: unknown[] = [];
  let i = 0;
  return {
    prompts,
    async sendPrompt(params: unknown): Promise<void> {
      prompts.push(params);
      const next = scripts[Math.min(i, scripts.length - 1)];
      i += 1;
      if (next?.kind === "reject") {
        throw new ZCodeV4CommandRejectedError("sendText", next.ack, "test");
      }
      if (next?.kind === "throw") {
        throw next.error;
      }
    },
    async createTask(): Promise<never> {
      throw new Error("本测试不触创建路径");
    },
    async resumeTask(): Promise<never> {
      throw new Error("本测试不触恢复路径");
    },
    async closeTask(): Promise<never> {
      throw new Error("本测试不触关闭路径");
    },
  };
}

const MCP_REFS = [{} as unknown as import("@zcode/shared").ZCodeOfficialMcpServerRef];

test("重启时输入被丢弃：同一编号再发只会重复失败，换新编号重发一次后成功", async () => {
  const { port, sent } = fakeSessions([
    { ok: false, code: "discardedOnRestart", detail: "fault.command.inputDiscardedOnRestart" },
    { ok: true, duplicate: false },
  ]);
  const handler = createRaftWakeDelivery({ store: fakeStore([makeBinding()]), sessions: port });
  const result = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.equal(result.kind, "accepted");
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.commandId, `${sent[0]?.commandId}:r1`, "第二次是原编号加重启后缀");
  assert.equal(sent[0]?.text, sent[1]?.text, "唤醒文本不变（无正文）");
});

test("重启时输入被丢弃：换新编号后仍被丢弃 → 按忙退避，不无限重发", async () => {
  const discarded: RaftSessionSendOutcome = {
    ok: false,
    code: "discardedOnRestart",
    detail: "fault.command.inputDiscardedOnRestart",
  };
  const { port, sent } = fakeSessions([discarded, discarded]);
  const handler = createRaftWakeDelivery({
    store: fakeStore([makeBinding()]),
    sessions: port,
    busyRetryAfterMs: 2_500,
  });
  const result = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.deepEqual(result, { kind: "busy", retryAfterMs: 2_500 });
  assert.equal(sent.length, 2, "最多重发一次");
});

test("targetLost 自愈：绑定上下文 resume 一次 → 原幂等键重投成功", async () => {
  const { port, sent, resumes } = fakeSessions(
    [
      { ok: false, code: "targetLost", detail: "ZCODE_SESSION_TARGET_NOT_FOUND" },
      { ok: true, duplicate: false },
    ],
    { ok: true },
  );
  const paused: string[] = [];
  const handler = createRaftWakeDelivery({
    store: fakeStore([makeBinding()]),
    sessions: port,
    resolveOfficialMcpServers: async () => MCP_REFS,
    onSessionUnrecoverable: (bindingId) => paused.push(bindingId),
  });
  const delivery = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.deepEqual(delivery, { kind: "accepted", runtimeSession: "3" });
  // resume 参数按绑定派生：记忆作用域 = Home + 显示名，官方 MCP 引用原样，归属盖章。
  assert.equal(resumes.length, 1);
  const resumed = resumes[0] as {
    workspacePath: string;
    sessionId: string;
    agentMemory: { homeRoot: string; agentName: string };
    officialMcpServers: unknown[];
    raftBindingId: string;
  };
  assert.equal(resumed.workspacePath, "/tmp/raft-homes/agent-a");
  assert.equal(resumed.sessionId, "sess-7");
  assert.deepEqual(resumed.agentMemory, { homeRoot: "/tmp/raft-homes/agent-a", agentName: "t0-test-agent" });
  assert.equal(resumed.officialMcpServers, MCP_REFS);
  assert.equal(resumed.raftBindingId, BINDING_ID);
  // 重投复用同一确定性幂等键（丢失前那次若实际已接受，此处判 duplicate 仍成功）。
  assert.equal(sent.length, 2);
  assert.equal(sent[0].commandId, sent[1].commandId);
  assert.deepEqual(paused, [], "自愈成功不置暂停");
});

test("targetLost 自愈失败：置异常暂停回调并按 noSession 退避", async () => {
  const { port, sent } = fakeSessions(
    [{ ok: false, code: "targetLost", detail: "ZCODE_SESSION_TARGET_NOT_FOUND" }],
    { ok: false, detail: "session row gone" },
  );
  const paused: string[] = [];
  const handler = createRaftWakeDelivery({
    store: fakeStore([makeBinding()]),
    sessions: port,
    resolveOfficialMcpServers: async () => MCP_REFS,
    onSessionUnrecoverable: (bindingId) => paused.push(bindingId),
  });
  const delivery = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.deepEqual(delivery, { kind: "noSession" });
  assert.deepEqual(paused, [BINDING_ID], "恢复失败必须置暂停让界面可见");
  assert.equal(sent.length, 1, "恢复失败不重投");
});

test("targetLost 官方 MCP 引用不可用：fail-closed 按不可恢复处理", async () => {
  const { port, resumes } = fakeSessions(
    [{ ok: false, code: "targetLost", detail: "ZCODE_SESSION_TARGET_NOT_FOUND" }],
    { ok: true },
  );
  const paused: string[] = [];
  const handler = createRaftWakeDelivery({
    store: fakeStore([makeBinding()]),
    sessions: port,
    resolveOfficialMcpServers: async () => undefined,
    onSessionUnrecoverable: (bindingId) => paused.push(bindingId),
  });
  const delivery = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.deepEqual(delivery, { kind: "noSession" });
  assert.deepEqual(paused, [BINDING_ID]);
  assert.equal(resumes.length, 0, "不降级成无 MCP 的 resume");
});

test("targetLost 未接线自愈依赖（最小装配）：按 busy 退避保持旧行为", async () => {
  const { port, resumes } = fakeSessions([
    { ok: false, code: "targetLost", detail: "ZCODE_SESSION_TARGET_NOT_FOUND" },
  ]);
  const handler = createRaftWakeDelivery({
    store: fakeStore([makeBinding()]),
    sessions: port,
    busyRetryAfterMs: 1_500,
  });
  const delivery = await handler.handleWake({ bindingId: BINDING_ID, wake: makeWake() });
  assert.deepEqual(delivery, { kind: "busy", retryAfterMs: 1_500 });
  assert.equal(resumes.length, 0);
});

test("zcodeSession 适配器：拒绝三态映射 + sendPrompt 参数形态（taskId/traceId/mode）", async () => {
  const service = fakeTaskService([
    { kind: "ok" },
    { kind: "reject", ack: ack("stale", { reasonCode: "session_gone" }) },
    { kind: "reject", ack: ack("failed", { reasonCode: "fault.runtime.dead" }) },
    { kind: "reject", ack: ack("rejected", { reasonCode: "fault.command.inputRejected" }) },
  ]);
  const port = createZcodeSessionPort(service);
  const outcomes = [];
  for (let i = 0; i < 4; i += 1) {
    outcomes.push(
      await port.sendQueuedText({
        workspacePath: "/tmp/wh",
        sessionId: "sess-7",
        commandId: `cmd-${i}`,
        text: "t",
      }),
    );
  }
  // accepted/duplicate/noop 在门面内部收为成功；门面不回传 ack，duplicate 按 false 报告。
  assert.deepEqual(outcomes[0], { ok: true, duplicate: false });
  assert.deepEqual(outcomes[1], { ok: false, code: "noSession", detail: "session_gone" });
  assert.deepEqual(outcomes[2], { ok: false, code: "transport", detail: "fault.runtime.dead" });
  assert.deepEqual(outcomes[3], { ok: false, code: "rejected", detail: "fault.command.inputRejected" });

  // sendPrompt 形态：taskId=主会话 id、traceId=确定性幂等键（commandId）、逐条 yolo。
  const first = service.prompts[0] as {
    taskId: string;
    traceId: string;
    content: string;
    mode: string;
  };
  assert.equal(first.taskId, "sess-7");
  assert.equal(first.traceId, "cmd-0");
  assert.equal(first.content, "t");
  // 每次投递显式 yolo：mode 固化进队列输入 intent，空草稿会话冷恢复后首个输入仍全自动。
  assert.equal(first.mode, "yolo");
});

test("zcodeSession 适配器：重启丢弃（inputDiscardedOnRestart）单列 discardedOnRestart，其余 failed 仍按 transport", async () => {
  const service = fakeTaskService([
    {
      kind: "reject",
      ack: ack("failed", {
        reasonCode: "fault.command.inputDiscardedOnRestart",
        message: "Input was discarded when the CLI restarted; confirm before resending.",
      }),
    },
    { kind: "reject", ack: ack("failed", { reasonCode: "fault.runtime.dead" }) },
  ]);
  const port = createZcodeSessionPort(service);
  const params = { workspacePath: "/tmp/wh", sessionId: "sess-7", commandId: "cmd", text: "t" };
  assert.deepEqual(await port.sendQueuedText(params), {
    ok: false,
    code: "discardedOnRestart",
    detail: "fault.command.inputDiscardedOnRestart",
  });
  assert.deepEqual(await port.sendQueuedText(params), {
    ok: false,
    code: "transport",
    detail: "fault.runtime.dead",
  });
});

test("zcodeSession 适配器：target 丢失单列 targetLost，其余门面异常按 transport", async () => {
  const port = createZcodeSessionPort(
    fakeTaskService([
      { kind: "throw", error: Object.assign(new Error("target is not loaded: sess-1"), { code: "ZCODE_SESSION_TARGET_NOT_FOUND" }) },
      { kind: "throw", error: new Error("connection closed") },
    ]),
  );
  // 重启后 target 映射丢失：单列 targetLost 供唤醒链自愈（适配器层自愈会丢绑定上下文）。
  const lost = await port.sendQueuedText({
    workspacePath: "/tmp/wh",
    sessionId: "s",
    commandId: "c",
    text: "t",
  });
  assert.deepEqual(lost, { ok: false, code: "targetLost", detail: "ZCODE_SESSION_TARGET_NOT_FOUND" });
  const crashed = await port.sendQueuedText({
    workspacePath: "/tmp/wh",
    sessionId: "s",
    commandId: "c2",
    text: "t",
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.ok === false && crashed.code, "transport");
});

test("zcodeSession 适配器：createTask 透传无人值守会话面（denylist/deferred/归属盖章）", async () => {
  const created: unknown[] = [];
  const service = {
    async sendPrompt(): Promise<void> {
      throw new Error("本测试不触投递路径");
    },
    async createTask(params: unknown): Promise<{ taskId: string }> {
      created.push(params);
      return { taskId: "task-1" };
    },
    async resumeTask(): Promise<never> {
      throw new Error("本测试不触恢复路径");
    },
    async closeTask(): Promise<never> {
      throw new Error("本测试不触关闭路径");
    },
  };
  const port = createZcodeSessionPort(service);
  const outcome = await port.createAgentSession({
    workspacePath: "/tmp/wh",
    agentMemory: { homeRoot: "/tmp/wh", agentName: "a" },
    officialMcpServers: [],
    raftBindingId: BINDING_ID,
  });
  assert.deepEqual(outcome, { ok: true, sessionId: "task-1" });
  const params = created[0] as {
    workspacePath: string;
    mode: string;
    toolDenylist: string[];
    confineFileToolsToWorkspace: boolean;
    deferPersistenceUntilFirstPrompt: boolean;
    raftBindingId: string;
  };
  assert.equal(params.workspacePath, "/tmp/wh");
  assert.equal(params.mode, "yolo");
  // 无人值守必挂的"等人回应"工具被排除；文件工具锁 workspace；deferred 解决空壳会话 FK。
  assert.deepEqual(params.toolDenylist, ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);
  assert.equal(params.confineFileToolsToWorkspace, true);
  assert.equal(params.deferPersistenceUntilFirstPrompt, true);
  assert.equal(params.raftBindingId, BINDING_ID);
});

test("buildWakePrompt：只含来源头与工具引导，不含消息正文", () => {
  const text = buildWakePrompt(makeWake());
  assert.ok(text.includes("messageId=msg-9"));
  assert.ok(text.includes("eventId=evt-9"));
  assert.ok(text.includes(BINDING_ID), "含适配实例标识");
  assert.ok(text.includes("raft_message_send"));
  assert.ok(text.includes("不要在命令行里直接调用 raft 命令"), "含 CLI 直调守卫（D5 防绕过）");
});
