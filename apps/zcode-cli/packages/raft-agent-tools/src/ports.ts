// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 工具适配（T4）的 app 层端口：收件日志存储与日志/告警出口。
 * 与 ports.ts（T1 的 CLI/绑定端口）分开，避免两个任务改同一个文件。
 */

/** 一条收件日志：`message check` 的完整输出（含正文，恢复依据）。 */
export interface InboxLogEntry {
  /** 写入时间（ISO）。 */
  receivedAt: string;
  source: "message_check";
  messageIds: string[];
  targets: string[];
  /** CLI 返回的规范文本原样保存。 */
  text: string;
}

export interface InboxLogPort {
  /** 追加一条日志；失败抛错（调用方负责有限重试）。 */
  append(bindingId: string, entry: InboxLogEntry): Promise<void>;
  /** 读取 sinceIso 之后的日志（恢复补查用），按时间升序。 */
  list(bindingId: string, opts?: { sinceIso?: string }): Promise<InboxLogEntry[]>;
  /** 清理早于保留期的日志，返回删除条数。 */
  purge(bindingId: string, opts: { olderThanMs: number }): Promise<number>;
  /** 删除该绑定的全部日志（用户显式删除绑定时）。 */
  removeAll(bindingId: string): Promise<void>;
}

/** 日志出口：应用日志只记 messageId 与条数，绝不记正文。 */
export interface ToolLoggerPort {
  info(message: string, fields?: Record<string, string | number | boolean>): void;
  warn(message: string, fields?: Record<string, string | number | boolean>): void;
}

/** 收件日志写失败时的上报（服务据此置 ErrorPaused(inbox_log_write_failed)）。 */
export interface InboxLogFailureSink {
  onInboxLogWriteFailed(bindingId: string, reason: string): void;
}

/** 默认保留 14 天；上限 30 天，配置不得超过上限。 */
export const DEFAULT_INBOX_LOG_RETENTION_DAYS = 14;
export const MAX_INBOX_LOG_RETENTION_DAYS = 30;

export function clampInboxLogRetentionDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days) || days <= 0)
    return DEFAULT_INBOX_LOG_RETENTION_DAYS;
  return Math.min(Math.floor(days), MAX_INBOX_LOG_RETENTION_DAYS);
}
