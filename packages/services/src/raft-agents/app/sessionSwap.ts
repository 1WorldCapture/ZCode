/**
 * 主会话生命周期共享段（二期 A1）：「创建 + 条件改绑」与「启动前会话解析」。
 *
 * createMainSessionAndRebind 的三个调用方共用同一语义：watchRuntime 的懒建分支
 * （首启创建）、resume 失败的重建分支、management 的换会话动作（重启/重置/
 * 打开会话兜底）。resolveMainSessionForStart（从 watchRuntime doStart 按职责
 * 下沉）：锁内换代结果分流——LazySessionCreate 走懒建；已有引用走 resume
 * （冷恢复重发记忆作用域与官方 MCP），失败重建（丢上下文、留记忆，代次重置 1）。
 *
 * 并发模型：createAgentSession 在锁外执行（RPC 慢，不占存储写锁）；随后锁内
 * 条件改绑——当前引用仍等于期望值（或仍为空）才写入，代次重置 1。防与并发
 * start/stop/remove 交错双写；并发方已改写引用时本次创建的会话留作历史
 * （无绑定引用，不会被唤醒投递命中）。
 */
import type { RaftAgentBinding, ZCodeAgentMemory, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftBindingStorePort, RaftSessionPort } from "./ports.js";
import type { RaftStoreWriteLock } from "./storeLock.js";

export interface RaftSessionSwapDeps {
  store: RaftBindingStorePort;
  lock: RaftStoreWriteLock;
  sessions: RaftSessionPort;
  clock?: { nowIso(): string };
  /**
   * 主会话编号变化广播（与 onBindingsChanged 同源）：改绑落盘成功后 fire 一次，
   * 覆盖所有换会话路径（懒建/恢复失败重建/管理动作/打开会话兜底）。缺省不广播。
   */
  emitBindingsChanged?: (next: RaftAgentBinding[]) => void;
}

export type RaftSessionSwapResult =
  | { ok: true; sessionId: string }
  /** create-failed = createAgentSession 失败；concurrent = 锁内条件不成立（引用已被并发方改写）。 */
  | { ok: false; code: "create-failed" | "concurrent"; detail?: string };

export async function createMainSessionAndRebind(
  deps: RaftSessionSwapDeps,
  input: {
    bindingId: string;
    workspacePath: string;
    agentMemory: ZCodeAgentMemory;
    officialMcpServers: ZCodeOfficialMcpServerRef[];
    /** 改绑条件：当前引用须仍等于该值；null = 须仍为空（懒建）。 */
    expectedSessionId: string | null;
    /** 可选意图守卫（值守路径用）：desiredState 须仍等于该值才改绑。 */
    expectedDesiredState?: RaftAgentBinding["desiredState"];
  },
): Promise<RaftSessionSwapResult> {
  const created = await deps.sessions.createAgentSession({
    workspacePath: input.workspacePath,
    agentMemory: input.agentMemory,
    officialMcpServers: input.officialMcpServers,
    // 创建即盖章绑定归属（tasks-index meta，B2/B3 按绑定归组）。
    raftBindingId: input.bindingId,
  });
  if (!created.ok) {
    return { ok: false, code: "create-failed", detail: created.detail };
  }
  const clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
  const bound = await deps.lock.withLock(async (): Promise<boolean> => {
    const bindings = await deps.store.readAll();
    const current = bindings.find((b) => b.bindingId === input.bindingId);
    if (!current) return false;
    if ((current.mainSessionRef?.sessionId ?? null) !== input.expectedSessionId) return false;
    if (input.expectedDesiredState !== undefined && current.desiredState !== input.expectedDesiredState) {
      return false;
    }
    const next: RaftAgentBinding = {
      ...current,
      mainSessionRef: { sessionId: created.sessionId, sessionGeneration: 1 },
      updatedAt: clock.nowIso(),
    };
    const nextAll = bindings.map((b) => (b.bindingId === input.bindingId ? next : b));
    await deps.store.writeAll(nextAll);
    // 写入成功、编号确实变了才广播一次（concurrent 分支不 fire，避免重复通知）。
    deps.emitBindingsChanged?.(nextAll);
    return true;
  });
  if (!bound) {
    return { ok: false, code: "concurrent" };
  }
  return { ok: true, sessionId: created.sessionId };
}

/** 启动前会话解析的结局（错误码由 watchRuntime 映射为对外 outcome，overlay 置位留在编排层）。 */
export type RaftStartSessionResult =
  | { ok: true; sessionId: string; generation: number; phase: "lazy" | "resumed" | "rebuilt" }
  | {
      ok: false;
      /** not-intent = 并发方已改写引用/意图（映射 NotRunningIntent）；create/resume-failed 见语义。 */
      code: "not-intent" | "create-failed" | "resume-failed";
      detail?: string;
    };

/**
 * 启动 bridge 之前解析主会话（顺序红线：完成之前绝不 spawn，spec §3）。
 * - lazy：无预建会话（二期 A1 懒建），创建 + 条件改绑（仍空引用 + desiredState
 *   仍 Running 才写），新会话代次 1；create 刚构建过带记忆与 MCP 的 runtime，无需 resume。
 * - resume：恢复既有会话（重发记忆作用域与官方 MCP 引用——冷恢复重建的 runtime
 *   缺了会退回项目记忆且无 Raft 工具）；失败 = 会话行已不存在，Home 记忆才是
 *   持久层 → 重建并改绑（丢上下文、留记忆），代次重置 1。
 */
export async function resolveMainSessionForStart(
  deps: RaftSessionSwapDeps & { logger?: ServiceLogger },
  input: {
    binding: RaftAgentBinding;
    mode: { kind: "lazy" } | { kind: "resume"; sessionId: string; generation: number };
    officialMcpServers: ZCodeOfficialMcpServerRef[];
  },
): Promise<RaftStartSessionResult> {
  const agentMemory: ZCodeAgentMemory = {
    homeRoot: input.binding.homeWorkspacePath,
    agentName: input.binding.displayName,
  };
  const swapInput = {
    bindingId: input.binding.bindingId,
    workspacePath: input.binding.homeWorkspacePath,
    agentMemory,
    officialMcpServers: input.officialMcpServers,
  };

  if (input.mode.kind === "lazy") {
    deps.logger?.info(undefined, "raft watch: no main session yet, creating lazily", {
      bindingId: input.binding.bindingId,
    });
    const swapped = await createMainSessionAndRebind(
      deps,
      { ...swapInput, expectedSessionId: null, expectedDesiredState: "Running" },
    );
    if (!swapped.ok) {
      if (swapped.code === "concurrent") return { ok: false, code: "not-intent" };
      return { ok: false, code: "create-failed", detail: swapped.detail };
    }
    deps.logger?.info(undefined, "raft watch: main session created lazily", {
      bindingId: input.binding.bindingId,
      sessionId: swapped.sessionId,
    });
    return { ok: true, sessionId: swapped.sessionId, generation: 1, phase: "lazy" };
  }

  const resumed = await deps.sessions.resumeAgentSession({
    workspacePath: input.binding.homeWorkspacePath,
    sessionId: input.mode.sessionId,
    agentMemory,
    officialMcpServers: input.officialMcpServers,
    raftBindingId: input.binding.bindingId, // pre-会话恢复补写归属（懒建已盖章）
  });
  if (resumed.ok) {
    return { ok: true, sessionId: input.mode.sessionId, generation: input.mode.generation, phase: "resumed" };
  }

  // resume 失败 = 会话行已不存在。历史主因是空壳预建会话从未越过统一持久化边界
  //（无输入即无 session 行，SPEC「主会话重建」2026-10-01 更正）——二期 A1 改懒建
  // 后不再产生；本分支留存兜底 db 被清/会话被他途归档等场景。
  deps.logger?.warn(undefined, "raft watch: session resume failed, rebuilding main session", {
    bindingId: input.binding.bindingId,
    oldSessionId: input.mode.sessionId,
    reason: resumed.detail,
  });
  const swapped = await createMainSessionAndRebind(deps, { ...swapInput, expectedSessionId: input.mode.sessionId });
  if (!swapped.ok) {
    if (swapped.code === "concurrent") return { ok: false, code: "not-intent" };
    return { ok: false, code: "resume-failed", detail: swapped.detail };
  }
  deps.logger?.info(undefined, "raft watch: main session rebuilt", {
    bindingId: input.binding.bindingId,
    oldSessionId: input.mode.sessionId,
    newSessionId: swapped.sessionId,
  });
  return { ok: true, sessionId: swapped.sessionId, generation: 1, phase: "rebuilt" };
}
