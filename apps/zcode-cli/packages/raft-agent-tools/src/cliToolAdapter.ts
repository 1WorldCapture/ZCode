/**
 * Raft 工具适配器（session 隔离，T4）：把白名单 Raft 操作封装成结构化调用，
 * 内部执行官方 raft CLI。与传输方式（stdio / http MCP）无关，由上层装配。
 *
 * 不变量：
 * 1. 身份固定：argv 前缀 = `--profile <slug>`，环境净化后只设 RAFT_PROFILE_DIR，
 *    不继承宿主或调用方的任何身份变量。
 * 2. `message check` 输出先写入收件日志（服务端读取即已标记送达，消息一旦丢失无法重放），
 *    写失败有限重试；仍失败则**仍把结果返回模型**并上报，绝不因为日志问题吞消息。
 * 3. 发帖被「新鲜度门」扣成草稿时，把 CLI 返回（含回放的新消息）原样交还模型，
 *    由模型决定发原稿、改稿或放弃；适配器不自动重试、不自动 --send-draft。
 * 4. 发帖超时/结果不确定时返回 unknown，不自动重发。
 * 5. 应用日志只记 messageId 与条数，不记正文。
 */
import { parseCliErrorCode, runCli } from "@zcode/shared/node/cli-process";
import { buildRaftCommand, parseCheckedMessages, type RaftToolCall } from "./toolCall.js";
import type { InboxLogFailureSink, InboxLogPort, ToolLoggerPort } from "./ports.js";

/** 固定身份：由绑定记录解析得到，调用方（模型）无法改变。 */
export interface RaftToolIdentity {
  bindingId: string;
  /** 官方 CLI 入口（T1 的 resolve() 已校验版本与入口）。 */
  cliPath: string;
  profileSlug: string;
  profileDir: string;
}

export type RaftToolResult =
  /** 成功；journalFailed=true 表示消息已返回但日志没写成（已上报）。 */
  | { kind: "ok"; text: string; journalFailed?: boolean }
  /** 发帖被扣成草稿：text 含 CLI 返回与回放的新消息，交还模型决定。 */
  | { kind: "held"; text: string }
  /** 结果不确定（超时/被杀）：不得自动重发，需人工对账。 */
  | { kind: "unknown"; text: string }
  /** CLI 明确失败。 */
  | { kind: "error"; text: string; code?: string }
  /** 参数不在白名单/校验失败：未执行任何命令。 */
  | { kind: "rejected"; reason: string };

export interface CliToolAdapterOptions {
  identity: RaftToolIdentity;
  inboxLog: InboxLogPort;
  failureSink?: InboxLogFailureSink;
  logger?: ToolLoggerPort;
  nowIso?: () => string;
  /** 日志写入有限重试；测试注入以免真实等待。 */
  logWriteAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CliToolAdapter {
  invoke(call: RaftToolCall): Promise<RaftToolResult>;
}

const DEFAULT_LOG_WRITE_ATTEMPTS = 3;
/** 官方 CLI 发送成功的权威输出行（raft-source send.ts：服务端确认后才打印）。 */
const SEND_SUCCESS_LINE = /^Message (?:sent|queued) to \S+\. Message ID: \S+/m;
const LOG_RETRY_DELAY_MS = 50;

export function createCliToolAdapter(options: CliToolAdapterOptions): CliToolAdapter {
  const { identity, inboxLog } = options;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.logWriteAttempts ?? DEFAULT_LOG_WRITE_ATTEMPTS);

  /** 有限重试写日志；返回失败原因（成功为 undefined）。 */
  async function journal(text: string): Promise<string | undefined> {
    const { messageIds, targets } = parseCheckedMessages(text);
    // 没有任何消息就不产生空日志（“No more new inbox messages”）。
    if (messageIds.length === 0) return undefined;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await inboxLog.append(identity.bindingId, {
          receivedAt: nowIso(),
          source: "message_check",
          messageIds,
          targets,
          text,
        });
        options.logger?.info("inbox log written", { messageCount: messageIds.length });
        return undefined;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(LOG_RETRY_DELAY_MS * attempt);
      }
    }
    return lastError || "unknown";
  }

  return {
    async invoke(call) {
      const built = buildRaftCommand(call);
      if (!built.ok) return { kind: "rejected", reason: built.reason };

      // 构造式 argv：固定身份前缀 + 校验后的业务参数。
      const argv = ["--profile", identity.profileSlug, ...built.argv];
      const run = await runCli(identity.cliPath, argv, {
        timeoutMs: built.timeoutMs,
        env: { RAFT_PROFILE_DIR: identity.profileDir },
        stdin: built.stdin,
        // 发送成功行是服务端确认后才打印的权威结果：看到它就不再等 CLI 自然退出
        //（联调实测：发送已成功但 CLI 残留句柄不退出，拖到 60s 超时被判"结果不确定"）。
        ...(call.tool === "message_send" ? { settleWhenStdoutMatches: SEND_SUCCESS_LINE } : {}),
      });

      const combined = [run.stdout, run.stderr].filter((part) => part.trim().length > 0).join("\n");

      // 被杀或未拿到退出码：对发帖意味着结果不确定——除非已经打印了权威成功行。
      if (run.status === null && call.tool === "message_send" && SEND_SUCCESS_LINE.test(run.stdout)) {
        return { kind: "ok", text: run.stdout };
      }
      if (run.status === null) {
        if (call.tool === "message_send") {
          return {
            kind: "unknown",
            text: combined || "发送超时或被中断，结果不确定；请勿自动重发，需人工对账。",
          };
        }
        return { kind: "error", text: combined || "命令超时或被中断" };
      }

      if (run.status !== 0) {
        const code = parseCliErrorCode(run.stderr);
        if (call.tool === "message_send" && code === "SEND_HELD_AS_DRAFT") {
          return { kind: "held", text: combined };
        }
        // 服务端已收到但客户端无法确认的发帖结果。
        if (call.tool === "message_send" && (code === "UNKNOWN" || code === "CANNOT_CONFIRM")) {
          return { kind: "unknown", text: combined };
        }
        return { kind: "error", text: combined, code };
      }

      if (call.tool === "message_check") {
        const failure = await journal(run.stdout);
        if (failure !== undefined) {
          // 消息已被服务端标记送达：仍返回给模型，只上报日志故障。
          options.logger?.warn("inbox log write failed", { bindingId: identity.bindingId });
          options.failureSink?.onInboxLogWriteFailed(identity.bindingId, failure);
          return { kind: "ok", text: run.stdout, journalFailed: true };
        }
      }
      return { kind: "ok", text: run.stdout };
    },
  };
}
