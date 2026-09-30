/**
 * Agent 列表/详情共用的状态展示映射。
 * 连接状态与运行状态是两个维度（spec §10），不允许压成一个状态点。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  RaftAgentConnectionState,
  RaftAgentErrorPauseReason,
  RaftAgentRunState,
} from "@/agents/types.js";
import { isErrorPaused } from "@/agents/types.js";

export function formatConnectionState(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  state: RaftAgentConnectionState,
): string {
  switch (state) {
    case "credential_ok":
      return formatMessage({ id: "agentCenter.connection.credential_ok" });
    case "credential_invalid":
      return formatMessage({ id: "agentCenter.connection.credential_invalid" });
    case "unverified":
      return formatMessage({ id: "agentCenter.connection.unverified" });
  }
}

export function formatErrorPauseReason(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  reason: RaftAgentErrorPauseReason,
): string {
  switch (reason) {
    case "memory_unavailable":
      return formatMessage({ id: "agentCenter.reason.memory_unavailable" });
    case "credential_invalid":
      return formatMessage({ id: "agentCenter.reason.credential_invalid" });
    case "bridge_exit":
      return formatMessage({ id: "agentCenter.reason.bridge_exit" });
    case "inbox_log_write_failed":
      return formatMessage({ id: "agentCenter.reason.inbox_log_write_failed" });
    case "cli_unavailable":
      return formatMessage({ id: "agentCenter.reason.cli_unavailable" });
  }
}

/** 运行状态的展示文案；ErrorPaused 附带原因，与用户暂停明确区分。 */
export function formatRunState(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  state: RaftAgentRunState,
): string {
  if (isErrorPaused(state)) {
    return `${formatMessage({ id: "agentCenter.state.errorPaused" })} · ${formatErrorPauseReason(formatMessage, state.reason)}`;
  }
  switch (state) {
    case "ReadyStopped":
      return formatMessage({ id: "agentCenter.state.readyStopped" });
    case "Starting":
      return formatMessage({ id: "agentCenter.state.starting" });
    case "Running":
      return formatMessage({ id: "agentCenter.state.running" });
    case "Stopping":
      return formatMessage({ id: "agentCenter.state.stopping" });
  }
}

/** 运行状态展示用色：异常暂停用警示色，其余保持中性。 */
export function runStateTextClass(state: RaftAgentRunState): string {
  if (isErrorPaused(state)) {
    return "text-amber-600 dark:text-amber-400";
  }
  switch (state) {
    case "Running":
      return "text-foreground";
    case "Starting":
    case "Stopping":
      return "text-foreground-subtle";
    case "ReadyStopped":
      return "text-foreground-subtlest";
  }
}

export function connectionStateTextClass(state: RaftAgentConnectionState): string {
  return state === "credential_invalid" ? "text-destructive" : "text-foreground-subtlest";
}
