/**
 * V4 主会话适配器（T3）：把唤醒投递翻译成 V4 sendText 命令。
 *
 * 调用形态照 zcodeTaskServiceAdapter 的既有提交链（createHostCommandEnvelope +
 * sendConversationCommandV4）；ACK 语义按 CommandInbox 契约映射：
 * accepted/duplicate/noop 成功（T0/spec §8.5：重复 messageId 的 duplicate 也是成功，
 * 报错会引发 bridge 退避）；stale = 会话目标失效；rejected = 业务拒绝不可重试；
 * failed/异常 = 传递层失败，可退避重试（commandId 确定性派生，重复提交被判 duplicate）。
 */
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

import { createHostCommandEnvelope } from "#src/zcode-agent/zcodeV4HostCommand.js";
import type {
  ZCodeAgentConversationCommandParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentResumeSessionParams,
} from "#src/zcode-agent/zcodeAgent.js";

import type { RaftSessionPort, RaftSessionSendOutcome } from "../app/ports.js";

/** zcodeAgentService 的最小结构面：只依赖用到的那个方法，测试替身无需整套服务。 */
export interface ZcodeSessionAgent {
  sendConversationCommandV4(params: ZCodeAgentConversationCommandParams): Promise<CommandAck>;
  /**
   * session/create RPC（非 V4 命令通道）：支持空会话创建与启动期注入
   * （agentMemory + officialMcpServers）。返回快照只需 session.sessionId（结构面收窄）。
   */
  createSession(params: ZCodeAgentCreateSessionParams): Promise<{ session: { sessionId: string } }>;
  /** session/resume RPC：冷恢复重建 runtime，agentMemory/officialMcpServers 随请求重发。 */
  resumeSession(params: ZCodeAgentResumeSessionParams): Promise<unknown>;
}

function ackToOutcome(ack: CommandAck): RaftSessionSendOutcome {
  if (ack.status === "accepted" || ack.status === "noop") return { ok: true, duplicate: false };
  if (ack.status === "duplicate") return { ok: true, duplicate: true };
  if (ack.status === "stale") return { ok: false, code: "noSession", detail: ack.reasonCode };
  if (ack.status === "failed") {
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
 * 权限模式锁 yolo；工具面用注册级白名单收死：Raft 六工具 + 维护 Home 记忆所需的
 * 最小文件工具集。刻意不含 Bash（唯一任意副作用入口）；也不含 ApplyPatch——其路径
 * 藏在 patch_text 里，confineFileToolsToWorkspace 的执行边界无法低成本校验，
 * Write/Edit 维护记忆足够（读写范围见 confineFileToolsToWorkspace，= Agent Home）。
 * MCP 工具全名依赖 app-server 锁定的 serverKey `raft_agent_tools`
 * （zcode-cli official-mcp-hosts.ts），工具集变更时两处必须同步。
 */
export const RAFT_MAIN_SESSION_TOOL_ALLOWLIST: readonly string[] = [
  "mcp__raft_agent_tools__raft_message_check",
  "mcp__raft_agent_tools__raft_message_read",
  "mcp__raft_agent_tools__raft_message_send",
  "mcp__raft_agent_tools__raft_task_list",
  "mcp__raft_agent_tools__raft_task_claim",
  "mcp__raft_agent_tools__raft_task_update",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "TodoWrite",
];

export function createZcodeSessionPort(agent: ZcodeSessionAgent): RaftSessionPort {
  return {
    async sendQueuedText(params) {
      let ack: CommandAck;
      try {
        ack = await agent.sendConversationCommandV4({
          workspacePath: params.workspacePath,
          envelope: createHostCommandEnvelope({
            type: "sendText",
            // 每次投递显式带 yolo：堵"空草稿会话重启后 resume 派生不出 mode 退回默认
            // ask 模式"的角落——mode 会固化进队列输入的 canonical intent，恢复后首个
            // 输入即重新锁定全自动。
            payload: { text: params.text, requestedDelivery: "queue", mode: "yolo" },
            sessionId: params.sessionId,
            commandId: params.commandId,
          }),
        });
      } catch (error) {
        // RPC/连接层异常：退避重试由调用方（wakeDelivery → busy）决定。
        return { ok: false, code: "transport", detail: String(error) };
      }
      return ackToOutcome(ack);
    },

    async createAgentSession(params) {
      try {
        const snapshot = await agent.createSession({
          workspacePath: params.workspacePath,
          agentMemory: params.agentMemory,
          officialMcpServers: params.officialMcpServers,
          // 无人值守权限模型（e2e S4 第五层）：yolo 全自动 + 注册级工具白名单 +
          // 文件工具锁定在 workspace（= Agent Home）内。三者缺一都会让值守会话
          // 挂起（yolo 缺失）或拿到过宽的执行面（后两者缺失）。
          mode: "yolo",
          toolAllowlist: [...RAFT_MAIN_SESSION_TOOL_ALLOWLIST],
          confineFileToolsToWorkspace: true,
          // 主会话的首个输入来自 V4 外部通道（drain/wake），必须以 deferred 草稿创建：
          // legacy session/create 缺省 persistence 时协议侧记 "immediate"，但 session 行
          // 只在首个输入的统一持久化边界写入；V4 durable admission 对非 deferred 记录
          // 跳过该边界直接写 session_input，外键（session_input→session）随之失败（e2e S4）。
          // deferred 下首个 V4 输入会先走 ensureSessionPersistedForExternalActivity 落行。
          persistence: "deferred",
        });
        return { ok: true, sessionId: snapshot.session.sessionId };
      } catch (error) {
        return { ok: false, code: "failed", detail: String(error) };
      }
    },

    async resumeAgentSession(params) {
      try {
        await agent.resumeSession({
          workspacePath: params.workspacePath,
          sessionId: params.sessionId,
          agentMemory: params.agentMemory,
          officialMcpServers: params.officialMcpServers,
          // 冷恢复重建 runtime：工具面与文件边界必须随 resume 重发（mode 除外——协议侧
          // 从持久化消息派生，且每条投递都显式带 yolo 兜底）。
          toolAllowlist: [...RAFT_MAIN_SESSION_TOOL_ALLOWLIST],
          confineFileToolsToWorkspace: true,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, code: "failed", detail: String(error) };
      }
    },
  };
}
