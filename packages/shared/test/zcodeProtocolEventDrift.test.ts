// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * R8：CLI 实际发出的事件字段必须被 strict 协议 schema 接受，防止"字段漂移"让整条事件被丢弃
 * （turn.started 的 executionStartedAt、tool.updated 的 readOnly / sideEffectScope / display）。
 * 样例按 CLI contracts 的 ToolCallStartedPayload / ToolCallScheduledPayload / TurnStarted 形状构造。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { zcodeSessionEventSchema } from "../src/zcode-protocol/index.js";

const envelope = {
  eventId: "evt-1",
  sessionId: "sess-1",
  turnId: "turn-1",
  seq: 3,
  timestamp: 1_790_000_000_000,
};

test("turn.started 接受 CLI 带的 executionStartedAt", () => {
  const parsed = zcodeSessionEventSchema.safeParse({
    ...envelope,
    type: "turn.started",
    payload: { turnNumber: 1, input: "hi", executionStartedAt: 123456.789 },
  });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("tool.updated(started) 接受解析后的 readOnly / sideEffectScope / display", () => {
  const parsed = zcodeSessionEventSchema.safeParse({
    ...envelope,
    type: "tool.updated",
    payload: {
      kind: "started",
      toolCallId: "tc-1",
      toolName: "Bash",
      startedAt: 1_790_000_000_100,
      readOnly: true,
      sideEffectScope: "none",
      display: { kind: "node_repl_images" },
    },
  });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("tool.updated(scheduled) 接受 display", () => {
  const parsed = zcodeSessionEventSchema.safeParse({
    ...envelope,
    type: "tool.updated",
    payload: {
      kind: "scheduled",
      toolCallId: "tc-1",
      toolName: "Read",
      display: { kind: "create_workflow" },
      schedule: {},
    },
  });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("strict 仍然拒绝未知字段与非法 sideEffectScope（只补已知漂移，不放宽）", () => {
  const unknown = zcodeSessionEventSchema.safeParse({
    ...envelope,
    type: "tool.updated",
    payload: { kind: "started", toolCallId: "tc-1", startedAt: 1, surprise: true },
  });
  assert.equal(unknown.success, false);
  const badScope = zcodeSessionEventSchema.safeParse({
    ...envelope,
    type: "tool.updated",
    payload: { kind: "started", toolCallId: "tc-1", startedAt: 1, sideEffectScope: "everything" },
  });
  assert.equal(badScope.success, false);
});
