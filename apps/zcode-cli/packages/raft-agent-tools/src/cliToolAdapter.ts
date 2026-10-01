/**
 * Raft 工具适配器（session 隔离，T4）：把白名单 Raft 操作封装成结构化调用，
 * 内部执行官方 raft CLI。与传输方式（stdio / http MCP）无关，由上层装配。
 *
 * 不变量：
 * 1. 身份固定：argv 前缀 = `--profile <slug>`，环境净化后只设 RAFT_PROFILE_DIR，
 *    不继承宿主或调用方的任何身份变量。
 * 2. 收件：命令行支持 claim/ack（fork `-zcode.N`，二期 A3）时走「claim → 落盘 → ack」，
 *    落盘成功才 ack，已落盘的消息不再交给模型；确认凭据只经 stdin，不进输出与日志。
 *    旧命令行走 `message check`（服务端读取即已标记送达）：先写日志，写失败有限重试；
 *    仍失败则**仍把结果返回模型**并上报，绝不因为日志问题吞消息。
 * 3. 发帖被「新鲜度门」扣成草稿时，把 CLI 返回（含回放的新消息）原样交还模型，
 *    由模型决定发原稿、改稿或放弃；适配器不自动重试、不自动 --send-draft。
 * 4. 发帖结果不确定：新命令行下每次调用带去重键，先查回执，未提交则同键重试一次；
 *    旧命令行或仍不确定时返回 unknown，不再自动重发。
 * 5. 应用日志只记 messageId 与条数，不记正文。
 */
import { randomUUID } from "node:crypto";
import { parseCliErrorCode, runCli, type CliRun } from "@zcode/shared/node/cli-process";
import {
  buildRaftCommand,
  parseCheckedMessages,
  parseClaimedText,
  renderClaimedText,
  type RaftToolCall,
} from "./toolCall.js";
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
  /** 发送去重键生成；测试注入。 */
  newSendKey?: () => string;
}

export interface CliToolAdapter {
  invoke(call: RaftToolCall): Promise<RaftToolResult>;
}

const DEFAULT_LOG_WRITE_ATTEMPTS = 3;
/** 官方 CLI 发送成功的权威输出行（raft-source send.ts：服务端确认后才打印）。 */
const SEND_SUCCESS_LINE = /^Message (?:sent|queued) to \S+\. Message ID: \S+/m;
const LOG_RETRY_DELAY_MS = 50;
const AUX_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
/** fork 命令行版本后缀：`0.0.24-zcode.1` 起支持 claim/ack/receipt/--idempotency-key。 */
const CLAIM_ACK_VERSION = /-zcode\.(\d+)\b/;
/** 服务端未部署 claim/ack 补丁时 claim 的失败形态（路由未登记）。 */
const CLAIM_ROUTE_MISSING = /Unregistered internal route|auth_policy_unregistered_path|HTTP 404/;
/** 去重集合首次从收件日志载入的回看窗口。 */
const DELIVERED_LOOKBACK_MS = 7 * 86_400_000;

type SendOutcome =
  | { kind: "ok"; text: string }
  | { kind: "held"; text: string }
  | { kind: "uncertain"; text: string }
  | { kind: "error"; text: string; code?: string };

function joinOutput(run: CliRun): string {
  return [run.stdout, run.stderr].filter((part) => part.trim().length > 0).join("\n");
}

export function createCliToolAdapter(options: CliToolAdapterOptions): CliToolAdapter {
  const { identity, inboxLog } = options;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.logWriteAttempts ?? DEFAULT_LOG_WRITE_ATTEMPTS);
  const newSendKey = options.newSendKey ?? (() => `zcode:${identity.bindingId}:${randomUUID()}`);

  // 构造式 argv：固定身份前缀 + 校验后的业务参数。
  function run(
    argv: string[],
    opts: { timeoutMs: number; stdin?: string; settleWhenStdoutMatches?: RegExp },
  ): Promise<CliRun> {
    return runCli(identity.cliPath, ["--profile", identity.profileSlug, ...argv], {
      timeoutMs: opts.timeoutMs,
      env: { RAFT_PROFILE_DIR: identity.profileDir },
      stdin: opts.stdin,
      ...(opts.settleWhenStdoutMatches
        ? { settleWhenStdoutMatches: opts.settleWhenStdoutMatches }
        : {}),
    });
  }

  let claimAckSupport: Promise<boolean> | undefined;
  /** 能力探测：一次 `--version`，结果缓存；失败按旧命令行处理。 */
  function supportsClaimAck(): Promise<boolean> {
    claimAckSupport ??= run(["--version"], { timeoutMs: PROBE_TIMEOUT_MS }).then(
      (probe) => {
        const match = probe.status === 0 ? CLAIM_ACK_VERSION.exec(probe.stdout) : null;
        return match?.[1] !== undefined && Number(match[1]) >= 1;
      },
      () => false,
    );
    return claimAckSupport;
  }

  let delivered: Promise<Set<string>> | undefined;
  const deliveredKey = (target: string, messageId: string) => `${target} ${messageId}`;
  /** 已交给模型的消息集合（进程内 + 首次从收件日志近 7 天载入）。 */
  function deliveredSet(): Promise<Set<string>> {
    delivered ??= (async () => {
      const set = new Set<string>();
      try {
        const since = new Date(Date.parse(nowIso()) - DELIVERED_LOOKBACK_MS).toISOString();
        for (const entry of await inboxLog.list(identity.bindingId, { sinceIso: since })) {
          for (const line of entry.text.split("\n")) {
            const header = /^\[target=(\S+)\s+msg=(\S+)/.exec(line);
            if (header?.[1] && header[2]) set.add(deliveredKey(header[1], header[2]));
          }
        }
      } catch {
        // 读不出历史只会多给一次重复消息，不影响正确性。
      }
      return set;
    })();
    return delivered;
  }

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

  function reportJournalFailure(failure: string): void {
    options.logger?.warn("inbox log write failed", { bindingId: identity.bindingId });
    options.failureSink?.onInboxLogWriteFailed(identity.bindingId, failure);
  }

  /** 旧命令行：`message check`（读取即已送达），先落盘再返回。 */
  async function checkLegacy(argv: string[], timeoutMs: number): Promise<RaftToolResult> {
    const result = await run(argv, { timeoutMs });
    if (result.status === null) return { kind: "error", text: joinOutput(result) || "命令超时或被中断" };
    if (result.status !== 0) {
      return { kind: "error", text: joinOutput(result), code: parseCliErrorCode(result.stderr) };
    }
    const failure = await journal(result.stdout);
    if (failure !== undefined) {
      // 消息已被服务端标记送达：仍返回给模型，只上报日志故障。
      reportJournalFailure(failure);
      return { kind: "ok", text: result.stdout, journalFailed: true };
    }
    return { kind: "ok", text: result.stdout };
  }

  /** 新命令行：claim → 去重 → 落盘 → ack。 */
  async function checkWithClaim(timeoutMs: number): Promise<RaftToolResult> {
    const claimed = await run(["message", "claim"], { timeoutMs });
    // 失败输出里不会有确认凭据（只在成功时打印），仍按行剥除以防万一。
    const strip = (text: string) =>
      text
        .split("\n")
        .filter((line) => !line.trim().startsWith("Claim-Ack:"))
        .join("\n");
    if (claimed.status === null) {
      return { kind: "error", text: strip(joinOutput(claimed)) || "命令超时或被中断" };
    }
    if (claimed.status !== 0) {
      // 命令行是新的、服务端还没部署补丁：本进程改走第一期路径，不报错。
      if (CLAIM_ROUTE_MISSING.test(joinOutput(claimed))) {
        options.logger?.warn("claim route missing on server; falling back to message check", {});
        claimAckSupport = Promise.resolve(false);
        return checkLegacy(["message", "check"], timeoutMs);
      }
      return {
        kind: "error",
        text: strip(joinOutput(claimed)),
        code: parseCliErrorCode(claimed.stderr),
      };
    }

    const parsed = parseClaimedText(claimed.stdout);
    const seen = await deliveredSet();
    const fresh = parsed.blocks.filter((b) => !seen.has(deliveredKey(b.target, b.messageId)));
    const duplicateCount = parsed.blocks.length - fresh.length;
    if (duplicateCount > 0) {
      options.logger?.info("inbox redelivery skipped", { messageCount: duplicateCount });
    }
    const text = renderClaimedText(fresh, parsed.hasMore);

    const failure = await journal(text);
    if (failure !== undefined) {
      // 不 ack：下次 claim 会再给到，宁重复不丢。
      reportJournalFailure(failure);
      return { kind: "ok", text, journalFailed: true };
    }
    for (const b of fresh) seen.add(deliveredKey(b.target, b.messageId));

    if (parsed.ackLine) {
      const acked = await run(["message", "ack"], {
        timeoutMs: AUX_TIMEOUT_MS,
        stdin: `${parsed.ackLine}\n`,
      });
      if (acked.status !== 0) {
        // 已落盘：下次 claim 重复给到的消息会被去重，不影响正确性。
        options.logger?.warn("inbox ack failed", {
          messageCount: parsed.blocks.length,
          code: parseCliErrorCode(acked.stderr) ?? "none",
        });
      }
    }
    return { kind: "ok", text };
  }

  async function sendOnce(
    argv: string[],
    stdin: string | undefined,
    timeoutMs: number,
  ): Promise<SendOutcome> {
    const result = await run(argv, {
      timeoutMs,
      stdin,
      // 发送成功行是服务端确认后才打印的权威结果：看到它就不再等 CLI 自然退出
      //（联调实测：发送已成功但 CLI 残留句柄不退出，拖到 60s 超时被判"结果不确定"）。
      settleWhenStdoutMatches: SEND_SUCCESS_LINE,
    });
    const combined = joinOutput(result);
    // 被杀或未拿到退出码：结果不确定——除非已经打印了权威成功行。
    if (result.status === null) {
      if (SEND_SUCCESS_LINE.test(result.stdout)) return { kind: "ok", text: result.stdout };
      return {
        kind: "uncertain",
        text: combined || "发送超时或被中断，结果不确定；请勿自动重发，需人工对账。",
      };
    }
    if (result.status !== 0) {
      const code = parseCliErrorCode(result.stderr);
      if (code === "SEND_HELD_AS_DRAFT") return { kind: "held", text: combined };
      // 服务端已收到但客户端无法确认的发帖结果。
      if (code === "UNKNOWN" || code === "CANNOT_CONFIRM") return { kind: "uncertain", text: combined };
      return { kind: "error", text: combined, code };
    }
    return { kind: "ok", text: result.stdout };
  }

  /** 回执：sent → 消息 id；not_found → null；查询失败 → undefined。 */
  async function lookupReceipt(key: string): Promise<string | null | undefined> {
    const result = await run(["message", "receipt", key, "--json"], { timeoutMs: AUX_TIMEOUT_MS });
    if (result.status !== 0) return undefined;
    try {
      const receipt = JSON.parse(result.stdout) as { status?: unknown; message_id?: unknown };
      if (receipt.status === "sent" && typeof receipt.message_id === "string") return receipt.message_id;
      if (receipt.status === "not_found") return null;
    } catch {
      // 输出不可解析按查询失败处理。
    }
    return undefined;
  }

  function toResult(outcome: SendOutcome): RaftToolResult {
    return outcome.kind === "uncertain" ? { kind: "unknown", text: outcome.text } : outcome;
  }

  async function sendWithKey(
    call: Extract<RaftToolCall, { tool: "message_send" }>,
    argv: string[],
    stdin: string | undefined,
    timeoutMs: number,
  ): Promise<RaftToolResult> {
    const key = newSendKey();
    const keyedArgv = [...argv, `--idempotency-key=${key}`];
    const first = await sendOnce(keyedArgv, stdin, timeoutMs);
    if (first.kind !== "uncertain") return toResult(first);

    const receipt = await lookupReceipt(key);
    if (typeof receipt === "string") {
      options.logger?.info("send confirmed by receipt", { messageId: receipt });
      return { kind: "ok", text: `Message sent to ${call.target}. Message ID: ${receipt}` };
    }
    if (receipt === undefined) return toResult(first);

    // 回执确认未提交：同一个键重试一次（服务端按键去重，不会发出两条）。
    options.logger?.info("send retried with same key", { attempt: 2 });
    return toResult(await sendOnce(keyedArgv, stdin, timeoutMs));
  }

  return {
    async invoke(call) {
      const built = buildRaftCommand(call);
      if (!built.ok) return { kind: "rejected", reason: built.reason };

      if (call.tool === "message_check") {
        return (await supportsClaimAck())
          ? checkWithClaim(built.timeoutMs)
          : checkLegacy(built.argv, built.timeoutMs);
      }
      if (call.tool === "message_send") {
        if (await supportsClaimAck()) {
          return sendWithKey(call, built.argv, built.stdin, built.timeoutMs);
        }
        return toResult(await sendOnce(built.argv, built.stdin, built.timeoutMs));
      }

      const result = await run(built.argv, { timeoutMs: built.timeoutMs, stdin: built.stdin });
      if (result.status === null) return { kind: "error", text: joinOutput(result) || "命令超时或被中断" };
      if (result.status !== 0) {
        return { kind: "error", text: joinOutput(result), code: parseCliErrorCode(result.stderr) };
      }
      return { kind: "ok", text: result.stdout };
    },
  };
}
