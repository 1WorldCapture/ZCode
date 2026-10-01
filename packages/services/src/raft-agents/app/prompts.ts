/**
 * 唤醒 / 值守 drain 的注入文本与幂等键（自 wakeDelivery 与 watchRuntime 收敛）：
 * 同一条日志纪律红线——文本只含来源头与操作引导，不含任何消息正文与凭据形态；
 * 正文只经 agent 会话内的 raft_message_check 工具获取（D5：先落收件日志再给模型）。
 * 工具名与 raft-agent-tools MCP 包的注册名一致（raft_message_check/read/send）。
 */
import type { RaftWakeRequest } from "./ports.js";

/** 稳定 wakeCycleId：同一 (bindingId, messageId) 的重复唤醒派生同一 commandId（spec §8.5）。 */
export function wakeCycleId(bindingId: string, messageId: string): string {
  return `raft-wake:${bindingId}:${messageId}`;
}

/** 唤醒 drain 文本：只含 wake.v1 携带的来源头（无正文），引导 agent 走收件工具。 */
export function buildWakePrompt(wake: RaftWakeRequest): string {
  return [
    "【Raft 唤醒】你有新的 Raft 事件需要处理。",
    `来源：messageId=${wake.messageId} eventId=${wake.eventId} attemptId=${wake.attemptId}`,
    `时间：${wake.occurredAt}`,
    `适配实例：${wake.adapterInstance}`,
    "",
    "注意：收发 Raft 消息和操作任务一律用 raft_* 工具，不要在命令行里直接调用 raft 命令（会绕过收件日志与去重，可能丢消息）。",
    "",
    "请依次执行：",
    "1. 用 raft_message_check 检查收件箱（输出会先落收件日志再返回给你）。",
    "2. 如有未读消息，用 raft_message_read 读取上下文；需要回复时用 raft_message_send 明确 target 发送。",
    "3. 处理完成后无需主动汇报；没有待办就静默结束，不要发无意义消息。",
  ].join("\n");
}

/** D8 积压 drain 的幂等键：代次参与派生，重启后的 drain 不被误判为重复（spec §8.5）。 */
export function backlogDrainCommandId(bindingId: string, generation: number): string {
  return `raft-drain:${bindingId}:${generation}`;
}

/** 积压 drain 文本：值守开始的引导（无 messageId 来源头），不含任何消息正文与凭据。 */
export function buildBacklogDrainPrompt(input: { bindingId: string; generation: number; nowIso: string }): string {
  return [
    "【Raft 值守开始】值守已启动，请先处理积压消息。",
    `来源：backlog drain（值守启动，无 messageId） 绑定=${input.bindingId} 代次=${input.generation}`,
    `时间：${input.nowIso}`,
    "",
    "注意：收发 Raft 消息和操作任务一律用 raft_* 工具，不要在命令行里直接调用 raft 命令（会绕过收件日志与去重，可能丢消息）。",
    "",
    "请依次执行：",
    "1. 用 raft_message_check 检查收件箱，处理全部未读（含值守开始前积累的积压）。",
    "2. 用 raft_message_read 读取上下文；需要回复时用 raft_message_send 明确 target 发送。",
    "3. 处理完成后静默结束；没有待办不要发无意义消息。",
  ].join("\n");
}
