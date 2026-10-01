/**
 * 二期 B2：主会话活动摘要（task #16，设计见线程 #zcode-raft-integration:553bb9c6）。
 *
 * 两个出口，都不新建事件存储：
 * 1. Raft 侧：映射成 raft-activity.v1 事件放进每绑定一个有上限的转发缓冲，由官方 bridge
 *    经 `/activity/drain` 取走转发给 Raft 服务端（服务端已有活动表持久保存与展示）。
 *    缓冲只是中转：取走即清，满了丢最旧并计入 dropped，进程重启丢失未转发部分可接受
 *    （会话本身完整保存在 ZCode）。
 * 2. ZCode 侧：实时投影（处理中/空闲/出错、当前事项、待处理数、等审批数、最近出错），
 *    并入 list() 的 activity 字段。完整历史由 B3 嵌入会话视图展示，这里不保留历史。
 *
 * 隐私口径：转发 Raft 的事件只含工具名、状态、耗时、错误码——不含工具输入/输出
 * （可能有文件内容、命令参数，频道成员都看得到）。progressText 只进本机投影。
 */
import type { RaftSessionActivityEvent, RaftSessionPort } from "./ports.js";

export const RAFT_ACTIVITY_EVENT_SCHEMA = "raft-activity.v1";
export const RAFT_ACTIVITY_DRAIN_SCHEMA = "raft-activity-drain.v1";
const DEFAULT_MAX_BUFFERED = 500;
const TOOL_NAME_LIMIT = 120;

/** Raft 已定义的外部 agent 活动事件（raft-source shared ExternalAgentActivityEvent 的子集）。 */
export interface RaftActivityWireEvent {
  schema: typeof RAFT_ACTIVITY_EVENT_SCHEMA;
  eventId: string;
  sessionId: string;
  hookEventName:
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "PostToolUseFailure"
    | "Stop"
    | "SessionStart"
    | "SessionEnd";
  status: "started" | "succeeded" | "failed" | "completed";
  occurredAt: string;
  toolName?: string;
  durationMs?: number;
  errorClass?: string;
}

export interface RaftActivityLive {
  phase: "idle" | "working" | "error";
  currentItem: string | null;
  pendingCount: number;
  pendingApprovals: number;
  lastSessionActivityAt: string | null;
  lastError: { code: string | null; at: string } | null;
}

export interface RaftActivityFeed {
  /** 值守开始（bridge 已连上）：记连接事件并订阅当前主会话（换代即换订）。 */
  attach(bindingId: string, target: { workspacePath: string; sessionId: string }): void;
  /** 停值守：退订并（bridge 原在跑时）记断开（保留已缓冲事件，投影回到空闲）。 */
  detach(bindingId: string, opts?: { bridgeWasRunning?: boolean }): void;
  /** 唤醒已投递进会话（待处理 +1，开始处理时 -1）。 */
  noteWakeAccepted(bindingId: string): void;
  /** bridge 连接事件（宿主编排层）。 */
  noteBridge(bindingId: string, state: "connected" | "disconnected", errorCode?: string): void;
  /** bridge 取走转发缓冲。 */
  drain(bindingId: string, max: number): { events: RaftActivityWireEvent[]; dropped: number };
  resolveLive(bindingId: string): RaftActivityLive | undefined;
  /** 删除绑定：退订并清空。 */
  clear(bindingId: string): void;
  disposeAll(): void;
}

interface FeedState {
  subscription?: { dispose(): void };
  sessionId?: string;
  buffer: RaftActivityWireEvent[];
  dropped: number;
  seq: number;
  phase: RaftActivityLive["phase"];
  currentItem: string | null;
  pendingCount: number;
  pendingApprovals: number;
  lastSessionActivityAt: string | null;
  lastError: RaftActivityLive["lastError"];
  toolStartedAt: Map<string, number>;
}

function clampToolName(name: string): string {
  return name.length > TOOL_NAME_LIMIT ? name.slice(0, TOOL_NAME_LIMIT) : name;
}

export function createRaftActivityFeed(options: {
  sessions: Pick<RaftSessionPort, "subscribeActivity">;
  maxBuffered?: number;
  nowMs?: () => number;
  logger?: { warn(traceId: undefined, message: string, fields?: Record<string, unknown>): void };
}): RaftActivityFeed {
  const maxBuffered = Math.max(1, options.maxBuffered ?? DEFAULT_MAX_BUFFERED);
  const nowMs = options.nowMs ?? Date.now;
  const states = new Map<string, FeedState>();

  function stateOf(bindingId: string): FeedState {
    let state = states.get(bindingId);
    if (!state) {
      state = {
        buffer: [],
        dropped: 0,
        seq: 0,
        phase: "idle",
        currentItem: null,
        pendingCount: 0,
        pendingApprovals: 0,
        lastSessionActivityAt: null,
        lastError: null,
        toolStartedAt: new Map(),
      };
      states.set(bindingId, state);
    }
    return state;
  }

  function push(
    bindingId: string,
    state: FeedState,
    event: Omit<RaftActivityWireEvent, "schema" | "eventId" | "sessionId" | "occurredAt">,
    at: number,
  ): void {
    state.seq += 1;
    state.buffer.push({
      schema: RAFT_ACTIVITY_EVENT_SCHEMA,
      // 进程内唯一即可：Raft 侧按 eventId 去重，换进程后计数从头但时间戳前缀不同。
      eventId: `zcode_${bindingId}_${at}_${state.seq}`,
      sessionId: state.sessionId ?? bindingId,
      occurredAt: new Date(at).toISOString(),
      ...event,
    });
    if (state.buffer.length > maxBuffered) {
      const overflow = state.buffer.length - maxBuffered;
      state.buffer.splice(0, overflow);
      state.dropped += overflow;
    }
  }

  function onSessionEvent(bindingId: string, event: RaftSessionActivityEvent): void {
    const state = stateOf(bindingId);
    state.lastSessionActivityAt = new Date(event.at).toISOString();
    switch (event.kind) {
      case "turnStarted":
        state.phase = "working";
        state.currentItem = null;
        state.pendingCount = Math.max(0, state.pendingCount - 1);
        push(bindingId, state, { hookEventName: "UserPromptSubmit", status: "started" }, event.at);
        return;
      case "toolStarted":
        state.phase = "working";
        if (event.progressText) state.currentItem = event.progressText;
        state.toolStartedAt.set(event.toolId, event.at);
        push(
          bindingId,
          state,
          {
            hookEventName: "PreToolUse",
            status: "started",
            toolName: clampToolName(event.toolName),
          },
          event.at,
        );
        return;
      case "toolFinished": {
        if (event.progressText) state.currentItem = event.progressText;
        const startedAt = state.toolStartedAt.get(event.toolId);
        state.toolStartedAt.delete(event.toolId);
        const ok = event.status === "completed";
        push(
          bindingId,
          state,
          {
            hookEventName: ok ? "PostToolUse" : "PostToolUseFailure",
            status: ok ? "succeeded" : "failed",
            toolName: clampToolName(event.toolName),
            ...(startedAt !== undefined ? { durationMs: Math.max(0, event.at - startedAt) } : {}),
            ...(ok ? {} : { errorClass: event.status }),
          },
          event.at,
        );
        return;
      }
      case "progress":
        state.currentItem = event.progressText;
        return;
      case "turnCompleted":
        state.phase = "idle";
        state.currentItem = null;
        // 回合结束即清零：drain 型注入可能被在跑的回合吸收、没有对应的 turnStarted 消账，
        // 不清会一直虚高；回合结束时若还有排队唤醒，下一轮从 0 起算（最多暂时少报）。
        state.pendingCount = 0;
        state.toolStartedAt.clear();
        push(bindingId, state, { hookEventName: "Stop", status: "completed" }, event.at);
        return;
      case "turnFailed":
        state.phase = "error";
        state.currentItem = null;
        state.pendingCount = 0;
        state.toolStartedAt.clear();
        state.lastError = { code: event.errorCode, at: new Date(event.at).toISOString() };
        push(
          bindingId,
          state,
          {
            hookEventName: "Stop",
            status: "failed",
            ...(event.errorCode ? { errorClass: event.errorCode } : {}),
          },
          event.at,
        );
        return;
      case "permissionRequested":
        state.pendingApprovals += 1;
        return;
      case "permissionResolved":
        state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
        return;
    }
  }

  function unsubscribe(state: FeedState): void {
    state.subscription?.dispose();
    state.subscription = undefined;
  }

  return {
    attach(bindingId, target) {
      const state = stateOf(bindingId);
      const sameSession = state.sessionId === target.sessionId;
      state.sessionId = target.sessionId;
      push(bindingId, state, { hookEventName: "SessionStart", status: "started" }, nowMs());
      if (state.subscription && sameSession) return;
      unsubscribe(state);
      if (!sameSession) {
        // 换代：新会话的处理状态从空闲起算（旧会话的进行中 turn 已被放弃）。
        state.phase = "idle";
        state.currentItem = null;
        state.pendingCount = 0;
        state.pendingApprovals = 0;
        state.toolStartedAt.clear();
      }
      if (!options.sessions.subscribeActivity) return;
      try {
        state.subscription = options.sessions.subscribeActivity(target, (event) =>
          onSessionEvent(bindingId, event),
        );
      } catch (error) {
        // 订阅失败只影响活动展示，不影响值守。
        options.logger?.warn(undefined, "raft activity subscribe failed", {
          bindingId,
          error: String(error),
        });
      }
    },

    detach(bindingId, opts) {
      const state = states.get(bindingId);
      if (!state) return;
      unsubscribe(state);
      if (opts?.bridgeWasRunning) {
        push(bindingId, state, { hookEventName: "SessionEnd", status: "completed" }, nowMs());
      }
      state.phase = "idle";
      state.currentItem = null;
      state.pendingCount = 0;
      state.pendingApprovals = 0;
      state.toolStartedAt.clear();
    },

    noteWakeAccepted(bindingId) {
      stateOf(bindingId).pendingCount += 1;
    },

    noteBridge(bindingId, bridgeState, errorCode) {
      const state = stateOf(bindingId);
      const at = nowMs();
      push(
        bindingId,
        state,
        bridgeState === "connected"
          ? { hookEventName: "SessionStart", status: "started" }
          : {
              hookEventName: "SessionEnd",
              status: errorCode ? "failed" : "completed",
              ...(errorCode ? { errorClass: errorCode } : {}),
            },
        at,
      );
    },

    drain(bindingId, max) {
      const state = states.get(bindingId);
      if (!state) return { events: [], dropped: 0 };
      const take = Math.max(0, Math.floor(max));
      const events = state.buffer.splice(0, take);
      const dropped = state.dropped;
      state.dropped = 0;
      return { events, dropped };
    },

    resolveLive(bindingId) {
      const state = states.get(bindingId);
      if (!state) return undefined;
      return {
        phase: state.phase,
        currentItem: state.currentItem,
        pendingCount: state.pendingCount,
        pendingApprovals: state.pendingApprovals,
        lastSessionActivityAt: state.lastSessionActivityAt,
        lastError: state.lastError,
      };
    },

    clear(bindingId) {
      const state = states.get(bindingId);
      if (state) unsubscribe(state);
      states.delete(bindingId);
    },

    disposeAll() {
      for (const state of states.values()) unsubscribe(state);
    },
  };
}
