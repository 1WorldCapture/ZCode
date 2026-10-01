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
 * - target 丢失自愈（R4 评审定稿，PM 指定）：宿主 target 表缺会话（targetLost）时
 *   按绑定上下文 resume 一次再原幂等键重投；恢复不了置
 *   ErrorPaused(session_unavailable)（经 onSessionUnrecoverable 进值守层覆盖层，
 *   界面可见），唤醒按 noSession 退避。自愈不在适配器做——冷恢复必须重发
 *   agentMemory/officialMcpServers（绑定派生），适配器缺这两样会让会话静默
 *   退回项目记忆、丢 Raft 工具。
 */
import type { RaftAgentBinding, ZCodeOfficialMcpServerRef } from "@zcode/shared";

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
  /** targetLost 自愈用：官方 MCP 具名引用解析（与值守/管理同源；undefined/空 = fail-closed）。 */
  resolveOfficialMcpServers?: (
    binding: RaftAgentBinding,
  ) => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
  /** targetLost 自愈失败回调：置 ErrorPaused(session_unavailable)（值守层实现）。 */
  onSessionUnrecoverable?: (bindingId: string) => void;
  logger?: ServiceLogger;
}

/** 会话就绪判定：值守中且主会话已建立，唤醒才有投递目标。 */
function sessionTargetOf(binding: RaftAgentBinding | undefined):
  | {
      ok: true;
      binding: RaftAgentBinding;
      workspacePath: string;
      sessionId: string;
      runtimeSession: string;
    }
  | { ok: false } {
  if (!binding || binding.desiredState !== "Running" || binding.mainSessionRef === null) {
    return { ok: false };
  }
  return {
    ok: true,
    binding,
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

      const sendOnce = () =>
        options.sessions.sendQueuedText({
          workspacePath: target.workspacePath,
          sessionId: target.sessionId,
          commandId: wakeCycleId(bindingId, wake.messageId),
          text: buildWakePrompt(wake),
        });

      let outcome = await sendOnce();

      if (!outcome.ok && outcome.code === "targetLost") {
        // target 丢失自愈（见文件头）：只在宿主接齐自愈依赖时执行；未接线
        //（最小装配）保持旧行为，落到下方 targetLost 分支按 busy 退避。
        if (options.resolveOfficialMcpServers && options.onSessionUnrecoverable) {
          // 官方 MCP 引用不可用 = 无法正确冷恢复（fail-closed，与值守启动门同判），
          // 按不可恢复处理，不降级成"无 MCP 的 resume"。
          const officialMcpServers = await options.resolveOfficialMcpServers(target.binding);
          const resumed =
            officialMcpServers && officialMcpServers.length > 0
              ? await options.sessions.resumeAgentSession({
                  workspacePath: target.workspacePath,
                  sessionId: target.sessionId,
                  agentMemory: {
                    homeRoot: target.binding.homeWorkspacePath,
                    agentName: target.binding.displayName,
                  },
                  officialMcpServers,
                  raftBindingId: target.binding.bindingId,
                })
              : {
                  ok: false as const,
                  code: "failed" as const,
                  detail: "official mcp refs unavailable",
                };
          if (!resumed.ok) {
            options.onSessionUnrecoverable(target.binding.bindingId);
            options.logger?.error(undefined, "raft wake: session target lost and resume failed, paused", {
              bindingId,
              detail: resumed.detail,
            });
            return { kind: "noSession" };
          }
          options.logger?.warn(undefined, "raft wake: session target lost, resumed once and retrying", {
            bindingId,
          });
          // 原幂等键重投：若丢失前那次实际已被接受，这里会得到 duplicate（仍成功）。
          outcome = await sendOnce();
        }
      }

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
      if (outcome.code === "targetLost") {
        // 自愈依赖未接线（最小装配）或接线但重投仍 targetLost：按可重试退避。
        options.logger?.warn(undefined, "raft wake: session target lost, suggest retry", {
          bindingId,
          detail: outcome.detail,
        });
        return { kind: "busy", retryAfterMs: busyRetryAfterMs };
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
