// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

// Agent 会话级配置的持久化与冷恢复读取（R5 / task #23）。
//
// 背景：v4 冷恢复（subscribe → resumePersistedSession → activateSessionForResume）
// 没有 host 参数通道。Raft Agent / CUA 这类会话在创建时下发的记忆作用域、官方
// MCP 引用、工具 allow/deny 与"文件工具限 workspace"如果不随会话落盘，CLI 进程
// 重启后的任何重订阅都会把会话按普通会话重建：退回项目记忆、丢 Raft 工具、
// 找回会被无人值守卡死的工具、文件工具不再受 Home 边界约束（安全回归）。
//
// 方案：创建/宿主恢复时把这几项写一条 session_entry（runtime/agent_session_config，
// id 含 sessionId——session_entry.id 是全库主键，固定字面量会让第二个 Agent 会话
// upsert 改绑第一个会话的配置，同款修复先例见 shared-context import 的 provenance）。
// touchSession:false——配置刷新不能伪装成任务活动时间。冷恢复读取后并入 resume
// 参数（按字段：宿主显式下发优先，缺席回填持久化值）。与 bash shell 快照、taskType
// 的"随会话持久化、恢复时回填"是同一先例。
//
// 安全不变量：快照只含路径与标识（homeRoot、MCP 具名引用），永不含凭据形态；
// agentSessionConfigOf 白名单式挑字段保证写入面，readAgentSessionConfig 形状守卫
// 保证读取面不会把坏数据当配置。
import { SESSION_ENTRY_AGENT_SESSION_CONFIG, type SessionEntryInfo, type SessionId } from "@zcode/contracts";
import type { ZCodeAgentMemory, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ZCodeSessionRecordParams } from "./server-operations.js";

/** 随会话持久化的 Agent 配置快照（协议参数的 agent 作用域子集）。 */
export interface AgentSessionConfigSnapshot {
  agentMemory?: ZCodeAgentMemory;
  officialMcpServers?: ZCodeOfficialMcpServerRef[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  confineFileToolsToWorkspace?: boolean;
}

/** 协调器/写入方需要的宿主能力窄面（避免反向 import 形成环，先例 cold-session-resume.ts）。 */
export interface AgentSessionConfigStoreHost {
  logger?: {
    warn(message: string, context?: Record<string, unknown>): void;
  };
  deps: {
    sessionStore?: {
      saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
      sessionEntries?(input: { sessionID: SessionId; type?: string }): Promise<SessionEntryInfo[]>;
    };
  };
}

/** 从 create/resume 参数提取快照；一项都没有（普通会话）返回 undefined。 */
export function agentSessionConfigOf(params: ZCodeSessionRecordParams): AgentSessionConfigSnapshot | undefined {
  const snapshot: AgentSessionConfigSnapshot = {
    ...(params.agentMemory ? { agentMemory: params.agentMemory } : {}),
    ...(params.officialMcpServers ? { officialMcpServers: params.officialMcpServers } : {}),
    ...(params.toolAllowlist ? { toolAllowlist: params.toolAllowlist } : {}),
    ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    ...(params.confineFileToolsToWorkspace !== undefined
      ? { confineFileToolsToWorkspace: params.confineFileToolsToWorkspace }
      : {}),
  };
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/**
 * 落一条配置 entry（幂等 upsert）。调用方必须保证 session 行已存在（session_entry
 * 外键 session(id)）：resume 路径天然满足；create 路径由 onSessionEvent 在
 * isSessionPersisted 翻真后触发。失败只告警——持久化失败时冷恢复退化为既有行为
 * （普通会话），不能反过来阻断会话创建/恢复。
 */
export async function persistAgentSessionConfigEntry(
  host: AgentSessionConfigStoreHost,
  sessionId: string,
  snapshot: AgentSessionConfigSnapshot,
): Promise<void> {
  const save = host.deps.sessionStore?.saveSessionEntry;
  if (!save) return;
  const now = Date.now();
  try {
    await save({
      id: `agent_session_config:${sessionId}`,
      sessionID: sessionId as SessionId,
      type: SESSION_ENTRY_AGENT_SESSION_CONFIG,
      touchSession: false,
      time: { created: now, updated: now },
      data: snapshot,
    });
  } catch (error) {
    host.logger?.warn("agent session config entry persist failed (cold resume will degrade)", {
      event: "zcode_protocol.agent_session_config.persist_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isPlainStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMcpEnvEntry(value: unknown): value is { name: string; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { value?: unknown }).value === "string"
  );
}

function isMcpRefArray(value: unknown): value is ZCodeOfficialMcpServerRef[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (ref) =>
      typeof ref === "object" &&
      ref !== null &&
      typeof (ref as { name?: unknown }).name === "string" &&
      Array.isArray((ref as { env?: unknown }).env) &&
      ((ref as { env?: unknown }).env as unknown[]).every(isMcpEnvEntry),
  );
}

function isAgentMemory(value: unknown): value is ZCodeAgentMemory {
  if (typeof value !== "object" || value === null) return false;
  const memory = value as Record<string, unknown>;
  return typeof memory.homeRoot === "string" && memory.homeRoot.length > 0;
}

/**
 * 读取会话的配置快照。缺失/宿主不支持/坏数据都返回 undefined（冷恢复退化为既有
 * 行为），不抛错；形状守卫只认白名单字段，坏 JSON 不会被当成有效配置。
 */
export async function readAgentSessionConfig(
  host: AgentSessionConfigStoreHost,
  sessionId: string,
): Promise<AgentSessionConfigSnapshot | undefined> {
  const read = host.deps.sessionStore?.sessionEntries;
  if (!read) return undefined;
  let entries: SessionEntryInfo[];
  try {
    entries = await read({ sessionID: sessionId as SessionId, type: SESSION_ENTRY_AGENT_SESSION_CONFIG });
  } catch {
    return undefined;
  }
  const latest = entries[entries.length - 1];
  if (!latest || typeof latest.data !== "object" || latest.data === null) return undefined;
  const raw = latest.data as Record<string, unknown>;
  const snapshot: AgentSessionConfigSnapshot = {
    ...(isAgentMemory(raw.agentMemory) ? { agentMemory: raw.agentMemory } : {}),
    ...(isMcpRefArray(raw.officialMcpServers) ? { officialMcpServers: raw.officialMcpServers } : {}),
    ...(isPlainStringArray(raw.toolAllowlist) ? { toolAllowlist: raw.toolAllowlist } : {}),
    ...(isPlainStringArray(raw.toolDenylist) ? { toolDenylist: raw.toolDenylist } : {}),
    ...(typeof raw.confineFileToolsToWorkspace === "boolean"
      ? { confineFileToolsToWorkspace: raw.confineFileToolsToWorkspace }
      : {}),
  };
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}
