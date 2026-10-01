/**
 * 二期 B2 活动摘要：会话事件映射（复用机器人进度格式化）、Raft 转发缓冲（上限/dropped/取走即清）、
 * 换代换订、待处理与等审批计数、隐私口径（转发事件不含工具输入/输出/进度文本）、drain 端点。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ZCodeStreamEvent } from "@zcode/shared";

import { toRaftSessionActivityEvent } from "../src/raft-agents/adapters/zcodeSession.js";
import { createWakeServer } from "../src/raft-agents/adapters/wakeServer.js";
import { createRaftActivityFeed } from "../src/raft-agents/app/activityFeed.js";
import type { RaftSessionActivityEvent } from "../src/raft-agents/app/ports.js";

const BINDING = "99999999-8888-4777-a666-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fakeSessions() {
  const listeners = new Map<string, (event: RaftSessionActivityEvent) => void>();
  const disposed: string[] = [];
  return {
    listeners,
    disposed,
    subscribeActivity(
      params: { workspacePath: string; sessionId: string },
      listener: (event: RaftSessionActivityEvent) => void,
    ) {
      listeners.set(params.sessionId, listener);
      return {
        dispose: () => {
          disposed.push(params.sessionId);
          listeners.delete(params.sessionId);
        },
      };
    },
  };
}

test("映射：开始/工具/结束/失败/审批，进度文本复用 statusFormatting", () => {
  const base = { taskId: "t", traceId: "tr" } as const;
  assert.deepEqual(
    toRaftSessionActivityEvent(
      { ...base, type: "task_run_started", startedAt: 1000 } as unknown as ZCodeStreamEvent,
      5,
    ),
    { kind: "turnStarted", at: 1000 },
  );
  const started = toRaftSessionActivityEvent(
    {
      ...base,
      type: "tool_call",
      toolId: "a",
      toolName: "Bash",
      kind: "Bash",
      title: "Bash",
      input: { command: "git status" },
      raw: {},
    } as unknown as ZCodeStreamEvent,
    10,
  );
  assert.equal(started?.kind, "toolStarted");
  assert.equal(started?.kind === "toolStarted" && started.toolName, "Bash");
  assert.match(
    started?.kind === "toolStarted" ? (started.progressText ?? "") : "",
    /Bash: git status/,
  );
  const finished = toRaftSessionActivityEvent(
    {
      ...base,
      type: "tool_call_update",
      toolId: "a",
      toolName: "Bash",
      status: "failed",
      raw: {},
    } as unknown as ZCodeStreamEvent,
    20,
  );
  assert.equal(finished?.kind === "toolFinished" && finished.status, "failed");
  const progress = toRaftSessionActivityEvent(
    {
      ...base,
      type: "tool_call_update",
      toolId: "a",
      title: "Grep",
      status: "in_progress",
      raw: {},
    } as unknown as ZCodeStreamEvent,
    25,
  );
  assert.deepEqual(
    progress,
    { kind: "progress", at: 25, progressText: "Grep [in_progress]" },
    "中间态只更新本机当前事项",
  );
  assert.deepEqual(
    toRaftSessionActivityEvent(
      {
        ...base,
        type: "task_error",
        error: "boom",
        code: "E_MODEL",
      } as unknown as ZCodeStreamEvent,
      30,
    ),
    { kind: "turnFailed", at: 30, errorCode: "E_MODEL" },
  );
  assert.equal(
    toRaftSessionActivityEvent({
      ...base,
      type: "agent_message_chunk",
    } as unknown as ZCodeStreamEvent),
    null,
  );
});

test("转发缓冲：Raft 事件只含工具名/状态/耗时/错误码；取走即清", () => {
  const sessions = fakeSessions();
  const feed = createRaftActivityFeed({ sessions, nowMs: () => 50 });
  feed.attach(BINDING, { workspacePath: "/home/a", sessionId: "s1" });
  const emit = sessions.listeners.get("s1");
  assert.ok(emit);
  emit({ kind: "turnStarted", at: 100 });
  emit({
    kind: "toolStarted",
    at: 110,
    toolId: "x",
    toolName: "Bash",
    progressText: "Bash: cat secret.txt",
  });
  emit({
    kind: "toolFinished",
    at: 150,
    toolId: "x",
    toolName: "Bash",
    status: "completed",
    progressText: "Bash [completed]: cat secret.txt",
  });
  emit({ kind: "turnCompleted", at: 160 });

  const { events, dropped } = feed.drain(BINDING, 100);
  assert.equal(dropped, 0);
  assert.deepEqual(
    events.map((e) => [e.hookEventName, e.status, e.toolName ?? null, e.durationMs ?? null]),
    [
      ["SessionStart", "started", null, null],
      ["UserPromptSubmit", "started", null, null],
      ["PreToolUse", "started", "Bash", null],
      ["PostToolUse", "succeeded", "Bash", 40],
      ["Stop", "completed", null, null],
    ],
  );
  for (const e of events) {
    assert.equal(e.schema, "raft-activity.v1");
    assert.equal(e.sessionId, "s1");
    assert.ok(!JSON.stringify(e).includes("secret.txt"), "进度文本/输入不得转发 Raft");
  }
  assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
  assert.deepEqual(feed.drain(BINDING, 100).events, []);
});

test("转发缓冲有上限：满了丢最旧并计入 dropped，dropped 报一次后清零", () => {
  const sessions = fakeSessions();
  const feed = createRaftActivityFeed({ sessions, maxBuffered: 3 });
  feed.attach(BINDING, { workspacePath: "/h", sessionId: "s1" });
  feed.drain(BINDING, 10); // 取走 SessionStart
  const emit = sessions.listeners.get("s1");
  assert.ok(emit);
  for (let i = 0; i < 5; i += 1) emit({ kind: "turnStarted", at: 1000 + i });
  const first = feed.drain(BINDING, 2);
  assert.equal(first.events.length, 2);
  assert.equal(first.dropped, 2);
  assert.equal(first.events[0]?.occurredAt, new Date(1002).toISOString());
  const second = feed.drain(BINDING, 10);
  assert.equal(second.events.length, 1);
  assert.equal(second.dropped, 0);
});

test("本机投影：处理中/当前事项/待处理/等审批/出错；换代换订并重置；停值守退订", () => {
  const sessions = fakeSessions();
  const feed = createRaftActivityFeed({ sessions });
  feed.attach(BINDING, { workspacePath: "/h", sessionId: "s1" });
  feed.noteWakeAccepted(BINDING);
  feed.noteWakeAccepted(BINDING);
  assert.equal(feed.resolveLive(BINDING)?.pendingCount, 2);
  const emit = sessions.listeners.get("s1");
  assert.ok(emit);
  emit({ kind: "turnStarted", at: 1 });
  emit({
    kind: "toolStarted",
    at: 2,
    toolId: "x",
    toolName: "Read",
    progressText: "Read: notes/a.md",
  });
  emit({ kind: "permissionRequested", at: 3 });
  let live = feed.resolveLive(BINDING);
  assert.equal(live?.phase, "working");
  assert.equal(live?.currentItem, "Read: notes/a.md");
  assert.equal(live?.pendingCount, 1);
  assert.equal(live?.pendingApprovals, 1);
  emit({ kind: "permissionResolved", at: 4 });
  emit({ kind: "turnFailed", at: 5, errorCode: "E_X" });
  live = feed.resolveLive(BINDING);
  assert.equal(live?.phase, "error");
  assert.equal(live?.currentItem, null);
  assert.equal(live?.pendingApprovals, 0);
  assert.deepEqual(live?.lastError, { code: "E_X", at: new Date(5).toISOString() });

  // 同一会话重复 attach 不重订。
  feed.attach(BINDING, { workspacePath: "/h", sessionId: "s1" });
  assert.deepEqual(sessions.disposed, []);
  // 换代：退订旧会话、订新会话、处理状态归零。
  feed.attach(BINDING, { workspacePath: "/h", sessionId: "s2" });
  assert.deepEqual(sessions.disposed, ["s1"]);
  assert.ok(sessions.listeners.has("s2"));
  assert.equal(feed.resolveLive(BINDING)?.phase, "idle");
  assert.equal(feed.resolveLive(BINDING)?.pendingCount, 0);

  feed.detach(BINDING);
  assert.deepEqual(sessions.disposed, ["s1", "s2"]);
  feed.clear(BINDING);
  assert.equal(feed.resolveLive(BINDING), undefined);
});

test("会话端口不支持订阅时只缺展示，不抛错", () => {
  const feed = createRaftActivityFeed({ sessions: {} });
  feed.attach(BINDING, { workspacePath: "/h", sessionId: "s1" });
  feed.noteBridge(BINDING, "disconnected", "bridge_exit");
  const { events } = feed.drain(BINDING, 10);
  assert.deepEqual(
    events.map((e) => [e.hookEventName, e.status, e.errorClass ?? null]),
    [
      ["SessionStart", "started", null],
      ["SessionEnd", "failed", "bridge_exit"],
    ],
  );
});

test("drain 端点返回缓冲事件并遵守 max；token 校验不变", async () => {
  const sessions = fakeSessions();
  const feed = createRaftActivityFeed({ sessions });
  const server = createWakeServer({
    handler: { handleWake: async () => ({ kind: "noSession" }) },
    activity: feed,
  });
  await server.start();
  try {
    const opened = await server.open(BINDING, { expectedAgentId: AGENT_ID });
    feed.attach(BINDING, { workspacePath: "/h", sessionId: "s1" });
    const emit = sessions.listeners.get("s1");
    assert.ok(emit);
    feed.drain(BINDING, 10); // 取走 SessionStart
    emit({ kind: "turnStarted", at: 1 });
    emit({ kind: "turnCompleted", at: 2 });
    const drainUrl = opened.url.replace(/\/wake$/, "/activity/drain");
    const headers = { "x-raft-bridge-token": opened.token };
    const first = await fetch(`${drainUrl}?max=1`, { headers });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      schema: string;
      events: { hookEventName: string }[];
      dropped: number;
    };
    assert.equal(firstBody.schema, "raft-activity-drain.v1");
    assert.deepEqual(
      firstBody.events.map((e) => e.hookEventName),
      ["UserPromptSubmit"],
    );
    const rest = (await (await fetch(drainUrl, { headers })).json()) as {
      events: { hookEventName: string }[];
    };
    assert.deepEqual(
      rest.events.map((e) => e.hookEventName),
      ["Stop"],
    );
    const unauthorized = await fetch(drainUrl, {
      headers: { "x-raft-bridge-token": "0".repeat(opened.token.length) },
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await server.stop();
  }
});
