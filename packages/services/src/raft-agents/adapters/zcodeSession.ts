/**
 * V4 主会话适配器（T3）：把唤醒投递翻译成 V4 sendText 命令。
 *
 * 调用形态照 zcodeTaskServiceAdapter 的既有提交链（createHostCommandEnvelope +
 * sendConversationCommandV4）；ACK 语义按 CommandInbox 契约映射：
 * accepted/duplicate/noop 成功（T0/spec §8.5：重复 messageId 的 duplicate 也是成功，
 * 报错会引发 bridge 退避）；stale = 会话目标失效；rejected = 业务拒绝不可重试；
 * failed/异常 = 传递层失败，可退避重试（commandId 确定性派生，重复提交被判 duplicate）。
 */
import type { CommandAck } from "@zcode/shared";

import { createHostCommandEnvelope } from "#src/zcode-agent/zcodeV4HostCommand.js";
import type { ZCodeAgentConversationCommandParams } from "#src/zcode-agent/zcodeAgent.js";

import type { RaftSessionPort, RaftSessionSendOutcome } from "../app/ports.js";

/** zcodeAgentService 的最小结构面：只依赖用到的那个方法，测试替身无需整套服务。 */
export interface ZcodeSessionAgent {
  sendConversationCommandV4(params: ZCodeAgentConversationCommandParams): Promise<CommandAck>;
}

function ackToOutcome(ack: CommandAck): RaftSessionSendOutcome {
  if (ack.status === "accepted" || ack.status === "noop") return { ok: true, duplicate: false };
  if (ack.status === "duplicate") return { ok: true, duplicate: true };
  if (ack.status === "stale") return { ok: false, code: "noSession", detail: ack.reasonCode };
  if (ack.status === "failed") {
    return { ok: false, code: "transport", detail: ack.reasonCode ?? ack.message };
  }
  return { ok: false, code: "rejected", detail: ack.reasonCode ?? ack.message };
}

export function createZcodeSessionPort(agent: ZcodeSessionAgent): RaftSessionPort {
  return {
    async sendQueuedText(params) {
      let ack: CommandAck;
      try {
        ack = await agent.sendConversationCommandV4({
          workspacePath: params.workspacePath,
          envelope: createHostCommandEnvelope({
            type: "sendText",
            payload: { text: params.text, requestedDelivery: "queue" },
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
  };
}
