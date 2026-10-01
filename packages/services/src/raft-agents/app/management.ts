/**
 * 二期 A1：管理动作编排（重启 / 重置 / 打开会话 / 删除前置拆除）。
 *
 * 语义（PM 与 lyonliang 定稿，SPEC「二期 A1」）：
 * - 重启 = 新会话（同 Home / 记忆配置 / 官方 MCP）+ 改绑 + 代次重置为 1；
 *   原 Running 自动恢复值守。旧会话保留为历史（不关不删），进行中 turn 按崩溃
 *   口径由下次 drain 补查。
 * - 重置 = 先清 Home 记忆面（MEMORY.md / AGENTS.md / notes/ 整树）并按初始模板
 *   重建，再同重启换新会话。不动 Home 其他内容（projects/ 保留）、不动凭据与绑定。
 * - 打开会话（B3 宿主侧恢复入口）= 确保主会话存在（懒建）→ resume（带记忆与
 *   MCP，不退项目记忆）→ 返回会话坐标给渲染层挂现有会话视图。不启动 bridge。
 * - 删除前置拆除 = 停 bridge + session/close 归档产品会话（失败容忍，删除语义
 *   优先）；记录移除与 Home 删除由 service.removeBinding 继续。
 *
 * 并发模型：重启/重置/拆除整个段落在 runtime.runExclusive（与 start/stop 同链
 * 线性化）内执行，段内用 runtime.stopBridgeNow（不排队版）停 bridge；恢复值守的
 * startWatch 在段外调用（排队版，段内调用会自锁）。
 */
import type { RaftAgentBinding, ZCodeAgentMemory, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftActivityTracker } from "./activity.js";
import type { AgentHomePort } from "./agentHomePorts.js";
import type { ClockPort, RaftBindingStorePort, RaftSessionPort } from "./ports.js";
import { createMainSessionAndRebind } from "./sessionSwap.js";
import type { RaftStoreWriteLock } from "./storeLock.js";
import type {
  RaftAgentManagementResult,
  RaftAgentOpenSessionResult,
} from "@zcode/shared";

/** runtime 的最小结构面：管理动作只依赖这四个操作（全量 RaftWatchRuntime 也满足）。 */
export interface RaftManagementRuntimePort {
  startWatch(bindingId: string): Promise<unknown>;
  runExclusive<T>(bindingId: string, fn: () => Promise<T>): Promise<T>;
  stopBridgeNow(bindingId: string): Promise<void>;
}

export interface RaftAgentManagementOptions {
  store: RaftBindingStorePort;
  /** 与 service / watchRuntime 同一把（宿主装配保证）。 */
  lock: RaftStoreWriteLock;
  sessions: RaftSessionPort;
  /** 完整 AgentHomePort 面：重置用 resetMemorySurface + initialize。 */
  memory: AgentHomePort;
  runtime: RaftManagementRuntimePort;
  resolveOfficialMcpServers: (binding: RaftAgentBinding) => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
  activity?: RaftActivityTracker;
  clock?: ClockPort;
  logger?: ServiceLogger;
}

export interface RaftAgentManagement {
  restartBinding(bindingId: string): Promise<RaftAgentManagementResult>;
  resetBinding(bindingId: string): Promise<RaftAgentManagementResult>;
  openAgentSession(bindingId: string): Promise<RaftAgentOpenSessionResult>;
  /** removeBinding 前置：停 bridge + 关主会话（close 失败容忍）。 */
  teardownForRemoval(bindingId: string): Promise<void>;
}

function agentMemoryOf(binding: RaftAgentBinding): ZCodeAgentMemory {
  return { homeRoot: binding.homeWorkspacePath, agentName: binding.displayName };
}

export function createRaftAgentManagement(options: RaftAgentManagementOptions): RaftAgentManagement {
  const logger = options.logger;
  const clock: ClockPort = options.clock ?? { nowIso: () => new Date().toISOString() };
  const swapDeps = { store: options.store, lock: options.lock, sessions: options.sessions, clock };

  /**
   * 新建主会话并锁内条件改绑（共享段）。并发方已改写引用（如用户同时点了开始
   * 值守触发懒建）以并发方结果为准，本次新建的会话留作历史（无绑定引用，
   * 不会被唤醒投递命中）。
   */
  async function createAndRebind(
    bindingId: string,
    binding: RaftAgentBinding,
    officialMcpServers: ZCodeOfficialMcpServerRef[],
  ): Promise<{ ok: true; sessionId: string } | { ok: false; code: "SessionCreateFailed"; detail?: string }> {
    const swapped = await createMainSessionAndRebind(swapDeps, {
      bindingId,
      workspacePath: binding.homeWorkspacePath,
      agentMemory: agentMemoryOf(binding),
      officialMcpServers,
      expectedSessionId: binding.mainSessionRef?.sessionId ?? null,
    });
    if (swapped.ok) return { ok: true, sessionId: swapped.sessionId };
    if (swapped.code === "concurrent") {
      logger?.info(undefined, "raft management: binding changed during session create, keep concurrent ref", {
        bindingId,
      });
      return { ok: false, code: "SessionCreateFailed", detail: "binding changed concurrently" };
    }
    return { ok: false, code: "SessionCreateFailed", detail: swapped.detail };
  }

  /**
   * 重启/重置共用的会话换代段（在 runExclusive 内执行）：停 bridge → （可选的
   * 记忆重置已由调用方完成）→ 建新会话 → 改绑代次 1。恢复值守由段外统一处理。
   */
  async function swapSession(
    bindingId: string,
    binding: RaftAgentBinding,
  ): Promise<RaftAgentManagementResult> {
    const officialMcpServers = await options.resolveOfficialMcpServers(binding);
    if (officialMcpServers === undefined || officialMcpServers.length === 0) {
      options.activity?.record(bindingId, "error");
      logger?.warn(undefined, "raft management: official mcp unavailable, session swap aborted", { bindingId });
      return { ok: false, code: "SessionCreateFailed", detail: "mcp_unavailable" };
    }
    const swapped = await createAndRebind(bindingId, binding, officialMcpServers);
    if (!swapped.ok) {
      options.activity?.record(bindingId, "error");
      return { ok: false, code: swapped.code, detail: swapped.detail };
    }
    logger?.info(undefined, "raft management: main session swapped", {
      bindingId,
      newSessionId: swapped.sessionId,
      oldSessionId: binding.mainSessionRef?.sessionId ?? null,
    });
    return { ok: true };
  }

  /** 段外恢复值守（排队版 startWatch；失败只记日志——运行态由 list 投影呈现原因）。 */
  async function resumeWatchAfter(bindingId: string, wasRunning: boolean, action: string): Promise<void> {
    if (!wasRunning) return;
    try {
      await options.runtime.startWatch(bindingId);
    } catch (error) {
      logger?.warn(undefined, "raft management: watch restart after action failed", {
        bindingId,
        action,
        error: String(error),
      });
    }
  }

  return {
    async restartBinding(bindingId): Promise<RaftAgentManagementResult> {
      let wasRunning = false;
      let result: RaftAgentManagementResult;
      result = await options.runtime.runExclusive(bindingId, async () => {
        const binding = (await options.store.readAll()).find((b) => b.bindingId === bindingId);
        if (!binding) return { ok: false, code: "NotFound" as const };
        wasRunning = binding.desiredState === "Running";
        await options.runtime.stopBridgeNow(bindingId);
        return swapSession(bindingId, binding);
      });
      await resumeWatchAfter(bindingId, wasRunning, result.ok ? "restart" : "restart-failed-restore");
      return result;
    },

    async resetBinding(bindingId): Promise<RaftAgentManagementResult> {
      let wasRunning = false;
      let result: RaftAgentManagementResult;
      result = await options.runtime.runExclusive(bindingId, async () => {
        const binding = (await options.store.readAll()).find((b) => b.bindingId === bindingId);
        if (!binding) return { ok: false, code: "NotFound" as const };
        wasRunning = binding.desiredState === "Running";
        await options.runtime.stopBridgeNow(bindingId);

        // 记忆面清空 + 初始模板重建（「缺失才写」语义在清空后即全量重建）。
        const cleared = await options.memory.resetMemorySurface({
          homeWorkspacePath: binding.homeWorkspacePath,
        });
        if (!cleared.ok) {
          options.activity?.record(bindingId, "error");
          logger?.warn(undefined, "raft management: memory surface reset failed", {
            bindingId,
            code: cleared.code,
            detail: cleared.detail,
          });
          return { ok: false, code: "MemoryResetFailed" as const, detail: cleared.detail ?? cleared.code };
        }
        try {
          await options.memory.initialize({
            bindingId: binding.bindingId,
            displayName: binding.displayName,
            homeWorkspacePath: binding.homeWorkspacePath,
          });
        } catch (error) {
          options.activity?.record(bindingId, "error");
          logger?.warn(undefined, "raft management: memory template re-init failed", {
            bindingId,
            error: String(error),
          });
          return { ok: false, code: "MemoryResetFailed" as const, detail: String(error) };
        }

        return swapSession(bindingId, binding);
      });
      await resumeWatchAfter(bindingId, wasRunning, result.ok ? "reset" : "reset-failed-restore");
      return result;
    },

    async openAgentSession(bindingId): Promise<RaftAgentOpenSessionResult> {
      const binding = (await options.store.readAll()).find((b) => b.bindingId === bindingId);
      if (!binding) return { ok: false, code: "NotFound" };
      const officialMcpServers = await options.resolveOfficialMcpServers(binding);
      if (officialMcpServers === undefined || officialMcpServers.length === 0) {
        return { ok: false, code: "McpUnavailable" };
      }
      const ref = binding.mainSessionRef;
      if (ref) {
        const resumed = await options.sessions.resumeAgentSession({
          workspacePath: binding.homeWorkspacePath,
          sessionId: ref.sessionId,
          agentMemory: agentMemoryOf(binding),
          officialMcpServers,
          // pre-会话恢复补写绑定归属（与值守恢复同款；历史行经此处顺手盖章）。
          raftBindingId: binding.bindingId,
        });
        if (resumed.ok) {
          return { ok: true, sessionId: ref.sessionId, workspacePath: binding.homeWorkspacePath };
        }
        logger?.warn(undefined, "raft management: open-session resume failed, rebuilding", {
          bindingId,
          oldSessionId: ref.sessionId,
          reason: resumed.detail,
        });
      }
      // 懒建 / 重建：create + 条件改绑（引用未变才写入）。
      const swapped = await createAndRebind(bindingId, binding, officialMcpServers);
      if (swapped.ok) {
        return { ok: true, sessionId: swapped.sessionId, workspacePath: binding.homeWorkspacePath };
      }
      // 改绑失败 = 并发方已建立会话：以现存引用为准返回（其会话同样带记忆与 MCP）。
      const reread = (await options.store.readAll()).find((b) => b.bindingId === bindingId);
      if (reread?.mainSessionRef) {
        return {
          ok: true,
          sessionId: reread.mainSessionRef.sessionId,
          workspacePath: reread.homeWorkspacePath,
        };
      }
      return { ok: false, code: "SessionCreateFailed", detail: swapped.detail };
    },

    async teardownForRemoval(bindingId): Promise<void> {
      await options.runtime.runExclusive(bindingId, async () => {
        await options.runtime.stopBridgeNow(bindingId);
        const binding = (await options.store.readAll()).find((b) => b.bindingId === bindingId);
        if (!binding?.mainSessionRef) return;
        const closed = await options.sessions.closeAgentSession({
          workspacePath: binding.homeWorkspacePath,
          sessionId: binding.mainSessionRef.sessionId,
        });
        if (!closed.ok) {
          // 删除语义优先：close 失败（如空壳草稿无 session 行）不阻断绑定移除。
          logger?.warn(undefined, "raft management: session close before removal failed (tolerated)", {
            bindingId,
            detail: closed.detail,
          });
        }
      });
    },
  };
}
