// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * list() 投影（从 raftAgentsService 拆出，纯函数，无状态）：
 * 绑定记录 + 编排层追踪 + 会话活动实时投影 → RaftAgentListItem。
 */
import type { RaftAgentBinding, RaftAgentListItem, RaftAgentRunState } from "@zcode/shared";

import type { RaftActivityFeed } from "./activityFeed.js";

/** 编排层追踪（唤醒/drain/出错、记忆门）+ 会话活动实时投影（B2）合成 list 的 activity。 */
export function mergeActivity(
  tracked: RaftAgentListItem["activity"] | undefined,
  live: ReturnType<RaftActivityFeed["resolveLive"]>,
): RaftAgentListItem["activity"] | undefined {
  if (!live) return tracked;
  const base = tracked ?? {
    lastActivityAt: null,
    lastActivityKind: null,
    memoryLoaded: false,
    pendingApprovals: 0,
  };
  const candidates = [base.lastActivityAt, live.lastSessionActivityAt].filter(
    (value): value is string => value !== null,
  );
  return {
    ...base,
    lastActivityAt: candidates.length > 0 ? candidates.sort().at(-1) ?? null : null,
    pendingApprovals: live.pendingApprovals,
    phase: live.phase,
    currentItem: live.currentItem,
    pendingCount: live.pendingCount,
    lastError: live.lastError,
  };
}

export function toListItem(
  binding: RaftAgentBinding,
  sources: {
    resolveRunState?: (binding: RaftAgentBinding) => RaftAgentRunState | undefined;
    activity?: RaftAgentListItem["activity"];
    live: ReturnType<RaftActivityFeed["resolveLive"]>;
    /** Home 归属分类（agentHomeKind 探测结论；缺省不投影该字段）。 */
    homeKind?: RaftAgentListItem["homeKind"];
  },
): RaftAgentListItem {
  // 运行态优先取值守编排器覆盖层（ErrorPaused/Running，T3）；无运行时源时按意图
  // 推导（Running 意图 → Starting，等编排器接管；ReadyStopped 如实投影）。
  const runState: RaftAgentRunState =
    binding.desiredState === "Running" ? (sources.resolveRunState?.(binding) ?? "Starting") : "ReadyStopped";
  const activity = mergeActivity(sources.activity, sources.live);
  return {
    bindingId: binding.bindingId,
    displayName: binding.displayName,
    raftOrigin: binding.raftOrigin,
    connectionState: "credential_ok",
    runState,
    homePath: binding.homeWorkspacePath,
    ...(sources.homeKind ? { homeKind: sources.homeKind } : {}),
    // B3 嵌入会话视图：列表直达主会话编号；null = 懒建未发生，
    // 冷恢复统一走 openAgentSession（绑定派生记忆 + MCP 的恢复/重建入口）。
    mainSessionId: binding.mainSessionRef?.sessionId ?? null,
    ...(activity ? { activity } : {}),
  };
}
