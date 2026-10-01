/**
 * 唤醒投递（T3）：WakeHandlerPort 的业务实现。
 *
 * 链路（spec §8.5）：绑定查找 → 会话就绪判定 → 组装 drain 文本 →
 * V4 sendText(requestedDelivery "queue") 以 wakeCycleId 为 commandId 提交 →
 * CommandInbox 接受（含 duplicate）即 accepted。
 *
 * 设计要点：
 * - 幂等：commandId = wakeCycleId(bindingId, messageId) 确定性派生；同一消息的重复唤醒
 *   在 CommandInbox 判 duplicate，仍返回 accepted——重复不是错误，报错会让 bridge 退避重试。
 * - fencing：本模块只做单读快照，不写绑定记录。会话换代后旧 sessionId 的提交被 V4 判
 *   stale（→ noSession），bridge 退避重试时自然命中新会话；绑定级 fencing 由 wakeServer
 *   的 token 换代承担（旧 bridge 立即失效）。
 * - 不碰消息正文：wake.v1 不带正文（红线），drain 文本构建在 prompts.ts；
 *   正文只经 agent 会话内的 raft_message_check 工具获取（D5：先落收件日志再给模型）。
 * - 停态拒绝投递：desiredState 非 Running 或无 mainSessionRef 时按 noSession 拒绝——
 *   bridge 本不应在此时存活，404 让它退避而不是把文本注进无人值守的会话。
 */
import type { RaftAgentBinding } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftActivityTracker } from "./activity.js";
import { buildWakePrompt, wakeCycleId } from "./prompts.js";
import type {
  RaftBindingStorePort,
  RaftSessionPort,
  WakeHandlerPort,
} from "./ports.js";

export interface RaftWakeDeliveryOptions {
  store: RaftBindingStorePort;
  sessions: RaftSessionPort;
  /** 传递层失败时建议 bridge 的退避间隔（毫秒）。 */
  busyRetryAfterMs?: number;
  /** 二期 A1：唤醒成功投递记一次 wake 活动（列表投影来源）。 */
  activity?: RaftActivityTracker;
  logger?: ServiceLogger;
}

/** 会话就绪判定：值守中且主会话已建立，唤醒才有投递目标。 */
function sessionTargetOf(binding: RaftAgentBinding | undefined):
  | { ok: true; workspacePath: string; sessionId: string; runtimeSession: string }
  | { ok: false } {
  if (!binding || binding.desiredState !== "Running" || binding.mainSessionRef === null) {
    return { ok: false };
  }
  return {
    ok: true,
    workspacePath: binding.homeWorkspacePath,
    sessionId: binding.mainSessionRef.sessionId,
    // runtimeSession = 主会话当前代次标识（spec §8.3）；桥接只回显不解析。
    runtimeSession: String(binding.mainSessionRef.sessionGeneration),
  };
}

export function createRaftWakeDelivery(options: RaftWakeDeliveryOptions): WakeHandlerPort {
  const busyRetryAfterMs = options.busyRetryAfterMs ?? 5_000;
  return {
    async handleWake(input) {
      const { bindingId, wake } = input;
      const bindings = await options.store.readAll();
      const binding = bindings.find((b) => b.bindingId === bindingId);
      const target = sessionTargetOf(binding);
      if (!target.ok) {
        options.logger?.info(undefined, "raft wake rejected: no ready session", { bindingId });
        return { kind: "noSession" };
      }

      const outcome = await options.sessions.sendQueuedText({
        workspacePath: target.workspacePath,
        sessionId: target.sessionId,
        commandId: wakeCycleId(bindingId, wake.messageId),
        text: buildWakePrompt(wake),
      });

      if (outcome.ok) {
        options.activity?.record(bindingId, "wake");
        // 日志纪律（spec §7）：只记 messageId 与计数形态，不记正文（唤醒本就无正文）。
        options.logger?.info(undefined, "raft wake delivered", {
          bindingId,
          messageId: wake.messageId,
          duplicate: outcome.duplicate,
        });
        return { kind: "accepted", runtimeSession: target.runtimeSession };
      }
      if (outcome.code === "noSession") {
        options.logger?.info(undefined, "raft wake: session target stale", {
          bindingId,
          detail: outcome.detail,
        });
        return { kind: "noSession" };
      }
      if (outcome.code === "transport") {
        // 退避重试安全：commandId 确定性派生，若上次实际已接受，重试会得到 duplicate。
        options.logger?.warn(undefined, "raft wake: transport failure, suggest retry", {
          bindingId,
          detail: outcome.detail,
        });
        return { kind: "busy", retryAfterMs: busyRetryAfterMs };
      }
      options.logger?.warn(undefined, "raft wake: command rejected", {
        bindingId,
        messageId: wake.messageId,
        detail: outcome.detail,
      });
      return { kind: "injectionFailed", detail: outcome.detail };
    },
  };
}
