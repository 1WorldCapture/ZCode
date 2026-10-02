// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createReadSequenceGuard } from "../src/agents/agentReadSequence.js";

test("读取序号守卫：后发起的请求使旧序号失效，慢响应被丢弃", () => {
  const guard = createReadSequenceGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.ok(guard.isCurrent(second));
  assert.ok(!guard.isCurrent(first));
  // 旧请求的 finally 不得复位新请求的 reading 态。
  assert.ok(!guard.isCurrent(first));
});

test("读取序号守卫：同一次请求全程有效", async () => {
  const guard = createReadSequenceGuard();
  const token = guard.begin();
  await Promise.resolve();
  assert.ok(guard.isCurrent(token));
});

test("读取序号守卫：两个守卫互不影响", () => {
  const a = createReadSequenceGuard();
  const b = createReadSequenceGuard();
  const tokenA = a.begin();
  b.begin();
  assert.ok(a.isCurrent(tokenA));
});
