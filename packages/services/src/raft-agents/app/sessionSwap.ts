/**
 * 主会话「创建 + 条件改绑」共享段（二期 A1）。
 *
 * 三个调用方共用同一语义：watchRuntime 的懒建分支（首启创建）、resume 失败的
 * 重建分支、management 的换会话动作（重启/重置/打开会话兜底）。
 *
 * 并发模型：createAgentSession 在锁外执行（RPC 慢，不占存储写锁）；随后锁内
 * 条件改绑——当前引用仍等于期望值（或仍为空）才写入，代次重置 1。防与并发
 * start/stop/remove 交错双写；并发方已改写引用时本次创建的会话留作历史
 * （无绑定引用，不会被唤醒投递命中）。
 */
import type { RaftAgentBinding, ZCodeAgentMemory, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { RaftBindingStorePort, RaftSessionPort } from "./ports.js";
import type { RaftStoreWriteLock } from "./storeLock.js";

export interface RaftSessionSwapDeps {
  store: RaftBindingStorePort;
  lock: RaftStoreWriteLock;
  sessions: RaftSessionPort;
  clock?: { nowIso(): string };
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
    await deps.store.writeAll(bindings.map((b) => (b.bindingId === input.bindingId ? next : b)));
    return true;
  });
  if (!bound) {
    return { ok: false, code: "concurrent" };
  }
  return { ok: true, sessionId: created.sessionId };
}
