// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 二期 A1：绑定级活动追踪（内存态投影，list() 的 activity 字段来源）。
 *
 * 设计要点：
 * - 只记"何时发生过什么种类的事"（wake / drain_submitted / error），不记消息正文、
 *   不记凭据形态（安全红线）；粒度到种类为止，turn 级细节待 B2 活动事件接入。
 * - 进程内存态、不持久化：活动摘要的价值窗口是"最近一次值守期"，重启后归零
 *   与 ErrorPaused 覆盖层的失忆语义一致（UI 已接受该口径）。
 * - memoryLoaded：最近一次 startWatch 的记忆门结果（true = MEMORY 校验通过并
 *   随 resume/create 注入会话）。
 * - pendingApprovals：yolo 值守无人工审批面，恒 0（schema 注释已声明）；字段
 *   保留在投影里是为 B2 之后接真实审批计数时不动形状。
 */
import type { RaftAgentListItem } from "@zcode/shared";

import type { ClockPort } from "./ports.js";

export type RaftActivityKind = "wake" | "drain_submitted" | "error";

export interface RaftActivityTracker {
  /** 记一次活动（同种类高频事件自然合并为"最近一次"）。 */
  record(bindingId: string, kind: RaftActivityKind): void;
  /** 最近一次 startWatch 的记忆门结果。 */
  setMemoryLoaded(bindingId: string, loaded: boolean): void;
  /** 清除绑定全部活动记录（删除绑定后不留投影残影）。 */
  clear(bindingId: string): void;
  /** list() 投影来源；无记录时返回 undefined（activity 为可选字段）。 */
  resolveActivity(bindingId: string): RaftAgentListItem["activity"] | undefined;
}

interface ActivityState {
  lastActivityAt: string;
  lastActivityKind: RaftActivityKind;
  memoryLoaded: boolean;
}

export function createRaftActivityTracker(options: { clock?: ClockPort } = {}): RaftActivityTracker {
  const clock: ClockPort = options.clock ?? { nowIso: () => new Date().toISOString() };
  const states = new Map<string, ActivityState>();

  function stateOf(bindingId: string): ActivityState {
    let state = states.get(bindingId);
    if (!state) {
      state = { lastActivityAt: "", lastActivityKind: "error", memoryLoaded: false };
      states.set(bindingId, state);
    }
    return state;
  }

  return {
    record(bindingId, kind) {
      const state = stateOf(bindingId);
      state.lastActivityAt = clock.nowIso();
      state.lastActivityKind = kind;
    },

    setMemoryLoaded(bindingId, loaded) {
      stateOf(bindingId).memoryLoaded = loaded;
    },

    clear(bindingId) {
      states.delete(bindingId);
    },

    resolveActivity(bindingId) {
      const state = states.get(bindingId);
      if (!state) return undefined;
      return {
        lastActivityAt: state.lastActivityAt === "" ? null : state.lastActivityAt,
        lastActivityKind: state.lastActivityAt === "" ? null : state.lastActivityKind,
        memoryLoaded: state.memoryLoaded,
        pendingApprovals: 0,
      };
    },
  };
}
