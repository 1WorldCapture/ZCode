// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/** list 投影（listProjection.ts，从 raftAgentsService 纯搬移拆出）：行为等价用例。 */
import assert from "node:assert/strict";
import test from "node:test";

import type { RaftAgentBinding } from "@zcode/shared";

import { mergeActivity, toListItem } from "../src/raft-agents/app/listProjection.js";

const binding = {
  bindingId: "b1",
  displayName: "Bot",
  raftOrigin: "https://raft.example",
  desiredState: "Running",
  homeWorkspacePath: "/tmp/home/workspace",
  mainSessionRef: { sessionId: "s1" },
} as unknown as RaftAgentBinding;

const live = {
  phase: "working" as const,
  currentItem: "reading",
  pendingCount: 2,
  pendingApprovals: 1,
  lastSessionActivityAt: "2026-10-01T10:00:00.000Z",
  lastError: null,
};

test("mergeActivity: 无实时投影时原样返回追踪值", () => {
  assert.equal(mergeActivity(undefined, undefined), undefined);
  const tracked = { lastActivityAt: "a", lastActivityKind: null, memoryLoaded: true, pendingApprovals: 0 };
  assert.equal(mergeActivity(tracked, undefined), tracked);
});

test("mergeActivity: 取较晚的活动时间，实时字段覆盖", () => {
  const merged = mergeActivity(
    { lastActivityAt: "2026-10-01T11:00:00.000Z", lastActivityKind: null, memoryLoaded: true, pendingApprovals: 0 },
    live,
  );
  assert.equal(merged?.lastActivityAt, "2026-10-01T11:00:00.000Z");
  assert.equal(merged?.memoryLoaded, true);
  assert.equal(merged?.pendingApprovals, 1);
  assert.equal(merged?.phase, "working");
  assert.equal(merged?.pendingCount, 2);
});

test("mergeActivity: 无追踪值时用默认底座", () => {
  const merged = mergeActivity(undefined, live);
  assert.equal(merged?.memoryLoaded, false);
  assert.equal(merged?.lastActivityAt, live.lastSessionActivityAt);
});

test("toListItem: 运行态推导与会话编号", () => {
  assert.equal(toListItem(binding, { live: undefined }).runState, "Starting");
  assert.equal(
    toListItem(binding, { live: undefined, resolveRunState: () => "ErrorPaused" }).runState,
    "ErrorPaused",
  );
  const stopped = toListItem({ ...binding, desiredState: "ReadyStopped" }, { live: undefined });
  assert.equal(stopped.runState, "ReadyStopped");
  assert.equal(toListItem(binding, { live: undefined }).mainSessionId, "s1");
  assert.equal("activity" in toListItem(binding, { live: undefined }), false);
});
