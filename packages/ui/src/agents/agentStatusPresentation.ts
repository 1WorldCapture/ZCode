/**
 * Agent 列表/详情共用的状态展示映射。
 * 连接状态与运行状态是两个维度（spec §10），不允许压成一个状态点。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { StatusDotTone } from "@/settings/StatusDot.js";
import type {
  RaftAgentConnectionState,
  RaftAgentErrorPauseReason,
  RaftAgentRunState,
} from "@/agents/types.js";
import { isErrorPaused } from "@/agents/types.js";

/**
 * 运行状态对应的状态圆点（复用设置页 StatusDot 惯例）：
 * 运行=绿、异常暂停=琥珀（凭据类原因=红）、过渡态=旋转、已停止=灰。
 */
export function runStateDot(state: RaftAgentRunState): { tone: StatusDotTone; spinning?: boolean } {
  if (isErrorPaused(state)) {
    return { tone: state.reason === "credential_invalid" ? "red" : "amber" };
  }
  switch (state) {
    case "Running":
      return { tone: "green" };
    case "Starting":
    case "Stopping":
      return { tone: "muted", spinning: true };
    case "ReadyStopped":
      return { tone: "muted" };
  }
}

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
    case "mcp_unavailable":
      return formatMessage({ id: "agentCenter.reason.mcp_unavailable" });
    case "session_unavailable":
      return formatMessage({ id: "agentCenter.reason.session_unavailable" });
    case "legacy_watch_held":
      return formatMessage({ id: "agentCenter.reason.legacy_watch_held" });
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
    return "text-warning";
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

/** 活动类型投影（B1 状态扩展，A1 接口形状）：最近一次活动的类别展示。 */
export type AgentActivityKind = "wake" | "drain_submitted" | "message_sent" | "error";

export function formatActivityKind(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  kind: AgentActivityKind,
): string {
  switch (kind) {
    case "wake":
      return formatMessage({ id: "agentCenter.activity.kind.wake" });
    case "drain_submitted":
      return formatMessage({ id: "agentCenter.activity.kind.drain_submitted" });
    case "message_sent":
      return formatMessage({ id: "agentCenter.activity.kind.message_sent" });
    case "error":
      return formatMessage({ id: "agentCenter.activity.kind.error" });
  }
}
