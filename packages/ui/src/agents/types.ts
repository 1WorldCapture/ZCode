/**
 * Raft Agent 展示模型的 UI 出口。
 *
 * 类型与 runtime schema 的唯一事实源在 packages/shared/src/raft-agents.ts（task #2）；
 * 这里只做转发，UI 不维护第二份定义。接入表单草稿沿用 shared 的 RaftAgentBindingInput。
 */
export {
  type RaftAgentBinding,
  type RaftAgentBindingInput,
  type RaftAgentConnectionState,
  type RaftAgentListItem,
  type RaftAgentRunState,
} from "@zcode/shared";

import type { RaftAgentRunState } from "@zcode/shared";

/** ErrorPaused 原因类型；shared 内联在 runState schema 里，这里做导出命名。 */
export type RaftAgentErrorPauseReason = Extract<
  RaftAgentRunState,
  { kind: "ErrorPaused" }
>["reason"];

export function isErrorPaused(
  state: RaftAgentRunState,
): state is Extract<RaftAgentRunState, { kind: "ErrorPaused" }> {
  return typeof state === "object" && state.kind === "ErrorPaused";
}
