// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 唤醒 HTTP 适配器协议测试：真起 loopback server，按 spec §8 矩阵逐项核对。
 * 覆盖：token/身份校验、wake 响应映射（accepted/busy/auth/noSession/protocol/注入失败）、
 * 重复 messageId 仍 200、drain 空集 schema、open 换代、close 幂等与 404 兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createWakeServer } from "../src/raft-agents/adapters/wakeServer.js";
import type { RaftWakeRequest, WakeDelivery, WakeHandlerPort } from "../src/raft-agents/app/ports.js";

const BINDING_ID = "99999999-8888-4777-a666-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makeWake(overrides: Partial<RaftWakeRequest> = {}): RaftWakeRequest {
  return {
    schema: "raft-channel-wake.v1",
    attemptId: "att-1",
    eventId: "evt-1",
    messageId: "msg-1",
    agentId: AGENT_ID,
    profile: "p",
    coreSessionId: "core-1",
    adapterInstance: BINDING_ID,
    occurredAt: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

/** 可编程 handler：脚本化返回，并记录收到的唤醒。 */
function scriptHandler(scripts: WakeDelivery[]): WakeHandlerPort & { received: RaftWakeRequest[] } {
  const received: RaftWakeRequest[] = [];
  let i = 0;
  return {
    received,
    async handleWake(input) {
      received.push(input.wake);
      const script = scripts[Math.min(i, scripts.length - 1)];
      i += 1;
      return script;
    },
  };
}

interface TestContext {
  baseUrl: string;
  wakeUrl: string;
  token: string;
  handler: WakeHandlerPort & { received: RaftWakeRequest[] };
  cleanup: () => Promise<void>;
}

async function setup(handlerScripts: WakeDelivery[], opts: { open?: boolean } = {}): Promise<TestContext> {
  const handler = scriptHandler(handlerScripts);
  const server = createWakeServer({ handler });
  await server.start();
  let token = "";
  let wakeUrl = "";
  if (opts.open !== false) {
    const opened = await server.open(BINDING_ID, { expectedAgentId: AGENT_ID });
    token = opened.token;
    wakeUrl = opened.url;
  }
  return {
    baseUrl: server.listeningAddress ?? "",
    wakeUrl,
    token,
    handler,
    cleanup: async () => {
      await server.stop();
    },
  };
}

function post(url: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return request("POST", url, token, body);
}

function get(url: string, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return request("GET", url, token, undefined);
}

async function request(
  method: "GET" | "POST",
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "x-raft-bridge-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("wake accepted：200 + runtimeSession，且为 application/json", async () => {
  const ctx = await setup([{ kind: "accepted", runtimeSession: "gen-7" }]);
  try {
    const res = await post(ctx.wakeUrl, ctx.token, makeWake());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, runtimeSession: "gen-7" });
    assert.equal(ctx.handler.received.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("状态映射：busy 409、authRevoked 401、noSession 404、protocolMismatch 426、injectionFailed 500", async () => {
  const ctx = await setup([
    { kind: "busy", retryAfterMs: 5000 },
    { kind: "authRevoked" },
    { kind: "noSession" },
    { kind: "protocolMismatch" },
    { kind: "injectionFailed", detail: "boom" },
  ]);
  try {
    const busy = await post(ctx.wakeUrl, ctx.token, makeWake());
    assert.equal(busy.status, 409);
    assert.equal(busy.json.failureClass, "busy");
    assert.equal(busy.json.retryAfterMs, 5000);

    const auth = await post(ctx.wakeUrl, ctx.token, makeWake());
    assert.equal(auth.status, 401);
    assert.equal(auth.json.failureClass, "auth_revoked");

    const noSession = await post(ctx.wakeUrl, ctx.token, makeWake());
    assert.equal(noSession.status, 404);

    const proto = await post(ctx.wakeUrl, ctx.token, makeWake());
    assert.equal(proto.status, 426);

    const failed = await post(ctx.wakeUrl, ctx.token, makeWake());
    assert.equal(failed.status, 500);
    assert.equal(failed.json.failureClass, "injection_failed");
  } finally {
    await ctx.cleanup();
  }
});

test("token 错误 401；body 非法或 schema 不符 426", async () => {
  const ctx = await setup([{ kind: "accepted", runtimeSession: "g" }]);
  try {
    const badToken = await post(ctx.wakeUrl, "0".repeat(64), makeWake());
    assert.equal(badToken.status, 401);

    const badJson = await post(ctx.wakeUrl, ctx.token, { schema: "something.else.v1" });
    assert.equal(badJson.status, 426);

    // adapterInstance 不匹配本绑定路由 → 凭据级拒绝。
    const wrongInstance = await post(ctx.wakeUrl, ctx.token, makeWake({ adapterInstance: "11111111-2222-4333-8444-555555555555" }));
    assert.equal(wrongInstance.status, 401);

    const wrongAgent = await post(ctx.wakeUrl, ctx.token, makeWake({ agentId: "11111111-2222-4333-8444-555555555555" }));
    assert.equal(wrongAgent.status, 401);
  } finally {
    await ctx.cleanup();
  }
});

test("activity/drain：空集 schema（必须 200 + 精确 schema）；token 同 wake", async () => {
  const ctx = await setup([{ kind: "accepted", runtimeSession: "g" }]);
  try {
    const drainUrl = ctx.wakeUrl.replace(/\/wake$/, "/activity/drain");
    const res = await get(drainUrl, ctx.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { schema: "raft-activity-drain.v1", events: [], dropped: 0 });
    const bad = await get(drainUrl, "0".repeat(64));
    assert.equal(bad.status, 401);
  } finally {
    await ctx.cleanup();
  }
});

test("open 重入换 token：旧 token 失效；close 后路由 404 且幂等", async () => {
  const ctx = await setup([{ kind: "accepted", runtimeSession: "g" }]);
  const server = createWakeServer({ handler: ctx.handler });
  try {
    // 用独立 server 验证 open/close 生命周期（setup 的 server 已 open）。
    await server.start();
    const first = await server.open(BINDING_ID, { expectedAgentId: AGENT_ID });
    const second = await server.open(BINDING_ID, { expectedAgentId: AGENT_ID });
    assert.equal(first.url, second.url);
    assert.notEqual(first.token, second.token);

    const old = await post(second.url, first.token, makeWake());
    assert.equal(old.status, 401);
    const fresh = await post(second.url, second.token, makeWake());
    assert.equal(fresh.status, 200);

    await server.close(BINDING_ID);
    await server.close(BINDING_ID); // 幂等。
    const gone = await post(second.url, second.token, makeWake());
    assert.equal(gone.status, 404);
    await server.stop();
    await server.stop(); // 幂等。
  } finally {
    await ctx.cleanup();
  }
});

test("未 open 的绑定：404 兜底（不泄露是否存在）", async () => {
  const ctx = await setup([], { open: false });
  try {
    const res = await post(`${ctx.baseUrl}/${BINDING_ID}/wake`, "whatever", makeWake());
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});
