/**
 * 唤醒 HTTP 适配器（T3）：单 loopback server 承载全部绑定的唤醒路由。
 *
 * wire 契约（spec §8，T0 对 raft-source f7682db 实测核实）：
 * - POST /<bindingId>/wake，头 `x-raft-bridge-token: <token>`，体 raft-channel-wake.v1（无正文）。
 * - 成功 200 `{ok:true, runtimeSession}`（须为 application/json，且 CommandInbox 接受后才返回）。
 * - 忙碌 409/429 `{ok:false, failureClass:"busy", retryAfterMs}`；凭据 401/403；
 *   协议不匹配 426/501；无会话 404/410；其余 injection_failed。
 * - GET /<bindingId>/activity/drain：返回 `{schema:"raft-activity-drain.v1", events:[], dropped:0}`
 *   （一期空集；200 但 schema 不符会被 bridge 记 ProtocolError，必须按 schema 返回）。
 *
 * token：每绑定独立、随机生成、只存内存不落盘；open 重入即换代（旧 bridge 自然失效）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { WakeEndpointPort } from "../app/bridgePorts.js";
import type { RaftWakeRequest, WakeDelivery, WakeHandlerPort } from "../app/ports.js";

/** 仅监听回环地址：唤醒面不对外网暴露。 */
const LOOPBACK_HOST = "127.0.0.1";

interface BindingRoute {
  token: string;
  expectedAgentId: string;
}

/** raft-channel-wake.v1 的运行时校验（宽松必填集合；多余字段容忍——向前兼容）。 */
function parseWakeBody(raw: string): RaftWakeRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const body = parsed as Record<string, unknown>;
  if (body.schema !== "raft-channel-wake.v1") return undefined;
  const strings = [body.attemptId, body.eventId, body.messageId, body.agentId, body.profile, body.coreSessionId, body.adapterInstance, body.occurredAt];
  if (strings.some((v) => typeof v !== "string" || v.length === 0)) return undefined;
  return {
    schema: "raft-channel-wake.v1",
    attemptId: body.attemptId as string,
    eventId: body.eventId as string,
    messageId: body.messageId as string,
    agentId: body.agentId as string,
    profile: body.profile as string,
    coreSessionId: body.coreSessionId as string,
    adapterInstance: body.adapterInstance as string,
    occurredAt: body.occurredAt as string,
  };
}

/** WakeDelivery → HTTP 状态与响应体（spec §8.3 映射）。 */
function respondWake(res: ServerResponse, delivery: WakeDelivery): void {
  if (delivery.kind === "accepted") {
    // 重复 messageId 也走这里：重复不是错误，报错会让 bridge 退避重试（spec §8.5）。
    sendJson(res, 200, { ok: true, runtimeSession: delivery.runtimeSession });
    return;
  }
  if (delivery.kind === "busy") {
    sendJson(res, 409, { ok: false, failureClass: "busy", retryAfterMs: delivery.retryAfterMs });
    return;
  }
  if (delivery.kind === "authRevoked") {
    sendJson(res, 401, { ok: false, failureClass: "auth_revoked" });
    return;
  }
  if (delivery.kind === "noSession") {
    sendJson(res, 404, { ok: false, failureClass: "no_session" });
    return;
  }
  if (delivery.kind === "protocolMismatch") {
    sendJson(res, 426, { ok: false, failureClass: "protocol_mismatch" });
    return;
  }
  sendJson(res, 500, { ok: false, failureClass: "injection_failed", detail: delivery.detail ?? "" });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  // 响应必须是 application/json，否则体被忽略（200 且无 runtimeSession 判 protocol_mismatch）。
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** 读取请求体（带上限，防异常客户端撑爆内存）。 */
function readBody(req: IncomingMessage, maxBytes = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface WakeServerOptions {
  handler: WakeHandlerPort;
  /** 回环端口；省略 0（随机），listen 后经 listeningAddress 取实际地址。 */
  port?: number;
}

export function createWakeServer(
  options: WakeServerOptions,
): WakeEndpointPort & { listeningAddress: string | undefined; start(): Promise<void>; stop(): Promise<void> } {
  const routes = new Map<string, BindingRoute>();
  let server: Server | undefined;
  let address: string | undefined;

  function send404(res: ServerResponse): void {
    sendJson(res, 404, { ok: false, failureClass: "no_session" });
  }

  function tokenOk(req: IncomingMessage, route: BindingRoute): boolean {
    // 等长 + 逐字节比较（时序安全形态）；token 是本机凭据，仍不放松。
    const header = req.headers["x-raft-bridge-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    if (typeof presented !== "string" || presented.length !== route.token.length) return false;
    return timingSafeEqualStr(presented, route.token);
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, failureClass: "injection_failed" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    // 路由形如 /<bindingId>/wake（2 段）或 /<bindingId>/activity/drain（3 段）。
    const isWake = parts.length === 2 && parts[1] === "wake" && req.method === "POST";
    const isDrain = parts.length === 3 && parts[1] === "activity" && parts[2] === "drain" && req.method === "GET";
    if (!isWake && !isDrain) {
      send404(res);
      return;
    }
    const bindingId = parts[0];
    const route = bindingId === undefined ? undefined : routes.get(bindingId);
    if (route === undefined) {
      send404(res);
      return;
    }
    if (!tokenOk(req, route)) {
      sendJson(res, 401, { ok: false, failureClass: "auth_revoked" });
      return;
    }
    if (isDrain) {
      // 一期空集（spec §8.4）：必须按 schema 返回，否则 bridge 记 ProtocolError。
      sendJson(res, 200, { schema: "raft-activity-drain.v1", events: [], dropped: 0 });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 426, { ok: false, failureClass: "protocol_mismatch" });
      return;
    }
    const wake = parseWakeBody(raw);
    if (wake === undefined) {
      sendJson(res, 426, { ok: false, failureClass: "protocol_mismatch" });
      return;
    }
    // 协议级身份核对：adapterInstance 必须即本绑定（spec §8.5），agentId 必须即期望身份。
    if (wake.adapterInstance !== bindingId || wake.agentId !== route.expectedAgentId) {
      sendJson(res, 401, { ok: false, failureClass: "auth_revoked" });
      return;
    }
    const delivery = await options.handler.handleWake({ bindingId, wake });
    respondWake(res, delivery);
  }

  return {
    get listeningAddress() {
      return address;
    },
    async start(): Promise<void> {
      if (server) return;
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.port ?? 0, LOOPBACK_HOST, () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") {
            address = `http://${LOOPBACK_HOST}:${addr.port}`;
          }
          resolve();
        });
      });
      server = httpServer;
    },
    async stop(): Promise<void> {
      const current = server;
      if (!current) return;
      server = undefined;
      address = undefined;
      routes.clear();
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        // 已完成响应的 keep-alive 连接不再等待。
        current.closeAllConnections?.();
      });
    },
    async open(bindingId, opts) {
      if (!server) throw new Error("wake server not started");
      // 重入换代：新 token 生成即宣告旧 token 失效（内存 map 原子替换）。
      const token = randomBytes(32).toString("hex");
      routes.set(bindingId, { token, expectedAgentId: opts.expectedAgentId });
      return { url: `${address}/${bindingId}/wake`, token };
    },
    async close(bindingId) {
      routes.delete(bindingId);
    },
  };
}

/** 时序安全的字符串比较（等长前提下逐字节异或）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
