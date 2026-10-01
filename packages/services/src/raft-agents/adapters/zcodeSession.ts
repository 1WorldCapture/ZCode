/**
 * 主会话适配器（T3 → R4）：值守会话驱动从 zcodeAgentService 裸 RPC 换到
 * IZCodeTaskService 任务门面——复用既有 task 生命周期（tasks-index 归档、
 * target 记忆、v4 命令幂等链），不再自持一条会话管线。RaftSessionPort 签名不变，
 * 行为映射：
 * - sendQueuedText → sendPrompt（commandId 即 traceId，幂等键等价；门面内部
 *   assertV4CommandAckOk 已把 accepted/duplicate/noop 收为成功，stale/rejected/
 *   failed 抛 ZCodeV4CommandRejectedError，此处映射回 noSession/rejected/transport；
 *   target 表丢失（重启后未恢复）单列 targetLost 供唤醒链自愈。
 *   duplicate 无法从门面回传——上游本就只用于日志，按 false 报告）。
 * - createAgentSession → createTask(deferPersistenceUntilFirstPrompt)：空壳会话的
 *   session 行由首个输入的统一持久化边界写入，session_input 外键随之成立（e2e S4）。
 * - resumeAgentSession → resumeTask：冷恢复随 resume 重发记忆作用域/官方 MCP/
 *   工具面/文件边界（mode 除外——协议侧从持久化消息派生，且每条投递显式带 yolo 兜底）。
 * - closeAgentSession → closeTask：关 session 并把 tasks-index 行标 deleted。
 */
import type { ZCodeStreamEvent } from "@zcode/shared";

import {
  formatStatusStreamToolProgress,
  truncateLiveStatusProgressText,
} from "#src/bots/statusFormatting.js";
import type { IZCodeTaskService } from "#src/session/zcodeTaskService.js";
import { ZCodeV4CommandRejectedError } from "#src/zcode-agent/zcodeV4HostCommand.js";

import type {
  RaftSessionActivityEvent,
  RaftSessionPort,
  RaftSessionSendOutcome,
} from "../app/ports.js";

/** zcodeTaskService 的最小结构面：只依赖用到的四个方法，测试替身无需整套服务。 */
export type ZcodeTaskSessionService = Pick<
  IZCodeTaskService,
  "createTask" | "sendPrompt" | "resumeTask" | "closeTask" | "onDynamicTaskEvent"
>;

/** 本机"当前事项"一行的长度上限（与机器人 /status 进度同量级）。 */
const PROGRESS_TEXT_MAX = 180;

function progressOf(event: Extract<ZCodeStreamEvent, { type: "tool_call" | "tool_call_update" }>): string | null {
  const text = formatStatusStreamToolProgress(event);
  return text ? truncateLiveStatusProgressText(text, PROGRESS_TEXT_MAX) : null;
}

/**
 * 二期 B2：ZCodeStreamEvent → 活动摘要最小事件面（只取展示需要的字段）。
 * 进度文本复用机器人 /status 的格式化（statusFormatting），不另写一套。
 */
export function toRaftSessionActivityEvent(
  event: ZCodeStreamEvent,
  now: number = Date.now(),
): RaftSessionActivityEvent | null {
  switch (event.type) {
    case "task_run_started":
      return { kind: "turnStarted", at: event.startedAt || now };
    case "tool_call":
      return {
        kind: "toolStarted",
        at: now,
        toolId: event.toolId,
        toolName: event.toolName ?? event.kind ?? "tool",
        progressText: progressOf(event),
      };
    case "tool_call_update": {
      if (
        event.status === "completed" ||
        event.status === "failed" ||
        event.status === "denied" ||
        event.status === "stopped"
      ) {
        return {
          kind: "toolFinished",
          at: now,
          toolId: event.toolId,
          toolName: event.toolName ?? event.kind ?? "tool",
          status: event.status,
          progressText: progressOf(event),
        };
      }
      const progressText = progressOf(event);
      return progressText ? { kind: "progress", at: now, progressText } : null;
    }
    case "task_complete":
      return { kind: "turnCompleted", at: now };
    case "task_error":
      return { kind: "turnFailed", at: now, errorCode: event.code ?? null };
    case "permission_request":
      return { kind: "permissionRequested", at: now };
    case "permission_response":
      return { kind: "permissionResolved", at: now };
    default:
      return null;
  }
}

/** v4 六态里门面会抛出的三种拒绝 → 投递结果（accepted/duplicate/noop 不经此处）。 */
function v4RejectionToOutcome(error: ZCodeV4CommandRejectedError): RaftSessionSendOutcome {
  const ack = error.ack;
  if (ack.status === "stale") return { ok: false, code: "noSession", detail: ack.reasonCode };
  if (ack.status === "failed") {
    // 重启时被丢弃的排队输入：结果随命令编号持久保存，同编号重发永远得到同一个失败，
    // 单独成码，让唤醒链换新编号重发（R8）。
    if (ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      return { ok: false, code: "discardedOnRestart", detail: ack.reasonCode };
    }
    // Keep both reasonCode and message: the gateway normalizes internal errors
    // to fault.command.executionFailed and the message carries the real cause.
    const detail = [ack.reasonCode, ack.message].filter(Boolean).join(": ");
    return { ok: false, code: "transport", detail: detail || "failed" };
  }
  return { ok: false, code: "rejected", detail: ack.reasonCode ?? ack.message };
}

/**
 * 主会话是无人值守会话：V4 缺省权限模式对 MCP 工具调用要求人工批准，值守场景
 * 无人批准会让工具调用永久悬挂（e2e S4 第五层，pendingPermissions 挂起）。
 * 权限模式锁 yolo；工具面与界面"完全允许"会话一致（lyonliang 定稿，task #18）：
 * 不设 allowlist（全量内置工具 + MCP 按注册面），仅 denylist 排除三个"等人回应"
 * 工具——AskUserQuestion 与 ExitPlanMode 声明 requiresUserInteraction，permission
 * service 里该分支排在 yolo 放行之前，且 permissionTimeoutMs 未设时 broker 无限等
 * （无人值守 = 无审批消费者 = 永久挂死）；EnterPlanMode 本身免批但会把会话切进
 * 只读计划态且无人能批准退出。文件工具仍锁 workspace（= Agent Home，应用层边界，
 * 与界面会话同款；命令行不受它管，等同口径即如此）。
 * MCP 工具全名依赖 app-server 锁定的 serverKey `raft_agent_tools`
 * （zcode-cli official-mcp-hosts.ts），工具集变更时两处必须同步。
 */
export const RAFT_MAIN_SESSION_TOOL_DENYLIST: readonly string[] = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
];

export function createZcodeSessionPort(service: ZcodeTaskSessionService): RaftSessionPort {
  return {
    async sendQueuedText(params) {
      try {
        await service.sendPrompt({
          taskId: params.sessionId,
          // 每次投递显式带 yolo：堵"空草稿会话重启后 resume 派生不出 mode 退回默认
          // ask 模式"的角落——mode 会固化进队列输入的 canonical intent，恢复后首个
          // 输入即重新锁定全自动。门面固定 keepQueueAndSend（无人值守队列语义）。
          traceId: params.commandId,
          content: params.text,
          mode: "yolo",
        });
        // accepted/duplicate/noop 同为成功；门面不回传 ack，duplicate 无法区分。
        return { ok: true, duplicate: false };
      } catch (error) {
        if (error instanceof ZCodeV4CommandRejectedError) {
          return v4RejectionToOutcome(error);
        }
        // 重启后 target 映射丢失（ZCODE_SESSION_TARGET_NOT_FOUND）：单列 targetLost，
        // 供唤醒链按绑定上下文 resume 自愈（PM 指定）；适配器层自愈会丢
        // agentMemory/officialMcpServers（resume 静默退回项目记忆），故只做识别。
        if ((error as NodeJS.ErrnoException).code === "ZCODE_SESSION_TARGET_NOT_FOUND") {
          return { ok: false, code: "targetLost", detail: "ZCODE_SESSION_TARGET_NOT_FOUND" };
        }
        // 其余 RPC/连接层异常走 transport（退避重试由调用方决定）。
        return { ok: false, code: "transport", detail: String(error) };
      }
    },

    async createAgentSession(params) {
      try {
        const created = await service.createTask({
          workspacePath: params.workspacePath,
          // 无人值守权限模型（e2e S4 第五层 + task #18 工具面定稿）：yolo 全自动 +
          // 工具面与界面"完全允许"会话一致（无 allowlist，仅 denylist 排除三个
          // 无人值守必挂的"等人回应"工具）+ 文件工具锁定在 workspace（= Agent Home）内。
          mode: "yolo",
          agentMemory: params.agentMemory,
          officialMcpServers: params.officialMcpServers,
          toolDenylist: [...RAFT_MAIN_SESSION_TOOL_DENYLIST],
          confineFileToolsToWorkspace: true,
          // 主会话的首个输入来自 V4 外部通道（drain/wake），必须以 deferred 草稿创建：
          // session 行只在首个输入的统一持久化边界写入；V4 durable admission 对非
          // deferred 记录跳过该边界直接写 session_input，外键（session_input→session）
          // 随之失败（e2e S4）——经门面的 deferPersistenceUntilFirstPrompt 承载。
          deferPersistenceUntilFirstPrompt: true,
          ...(params.raftBindingId ? { raftBindingId: params.raftBindingId } : {}),
        });
        return { ok: true, sessionId: created.taskId };
      } catch (error) {
        return { ok: false, code: "failed", detail: String(error) };
      }
    },

    async resumeAgentSession(params) {
      try {
        await service.resumeTask({
          taskId: params.sessionId,
          workspacePath: params.workspacePath,
          // 冷恢复重建 runtime：记忆作用域/官方 MCP/工具面/文件边界必须随 resume
          // 重发（缺失会退回项目记忆且无 Raft 工具）；mode 不重发（见文件头）。
          agentMemory: params.agentMemory,
          officialMcpServers: params.officialMcpServers,
          toolDenylist: [...RAFT_MAIN_SESSION_TOOL_DENYLIST],
          confineFileToolsToWorkspace: true,
          ...(params.raftBindingId ? { raftBindingId: params.raftBindingId } : {}),
        });
        return { ok: true };
      } catch (error) {
        // Session 不存在等异常原样透出：watchRuntime 依赖该失败触发主会话重建
        //（Home 记忆才是持久层，主会话是可重建的运行时资源）。
        return { ok: false, code: "failed", detail: String(error) };
      }
    },

    subscribeActivity(params, listener) {
      // 宿主侧常开订阅（与机器人同法，不依赖界面在看）；continuous = 直推语义。
      const subscription = service.onDynamicTaskEvent({
        workspacePath: params.workspacePath,
        taskId: params.sessionId,
        deliveryKind: "continuous",
      })((event) => {
        const mapped = toRaftSessionActivityEvent(event);
        if (mapped) listener(mapped);
      });
      return { dispose: () => subscription.dispose() };
    },

    async closeAgentSession(params) {
      try {
        // closeTask 关 session 并把 tasks-index 行标 deleted（统一回收路径）。
        // target 未加载（如重启后未恢复即删除）抛 ZCODE_SESSION_TARGET_NOT_FOUND：
        // 如实上报 failed，调用方（teardownForRemoval）删除语义优先、容忍失败。
        await service.closeTask({ taskId: params.sessionId });
        return { ok: true };
      } catch (error) {
        return { ok: false, code: "failed", detail: String(error) };
      }
    },
  };
}
