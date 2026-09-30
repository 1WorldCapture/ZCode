/**
 * 值守编排（T3）：把"开始/停止值守"意图变成 bridge 生命周期 + 会话换代 + 积压 drain。
 *
 * 链路（spec §3 崩溃恢复顺序 + §8.5 D8）：
 *   CLI 就绪 → MEMORY 门（T5 AgentHomePort.verifyMemoryAvailable；失败即
 *   ErrorPaused(memory_unavailable)，不碰 bridge）→ 官方 MCP 引用解析（fail-closed）→
 *   锁内换代 sessionGeneration+1 并持久化 → 会话恢复（resume 重发 agentMemory +
 *   officialMcpServers——冷恢复重建 runtime 缺了会退回项目记忆且无 Raft 工具；
 *   会话记录已随 agent 进程消亡时自动重建主会话并改绑，见 resume 分支注释）→
 *   supervisor.start → 成功后 D8 积压 drain（commandId 无 messageId，
 *   按 bindingId+启动代次派生，重启后的 drain 不被误判重复）。
 *
 * 设计要点：
 * - 状态覆盖层：ErrorPaused/Running 只存内存，list() 投影时叠加在 desiredState 推导
 *   之上；ErrorPaused 在下次 startWatch 成功或 stopWatch 时清除。bridge 意外退出经
 *   supervisor.onExit 置 ErrorPaused(bridge_exit)（spec §9）。
 * - 换代在锁内：与 RaftAgentsService 共用宿主装配注入的同一把 storeWriteLock，
 *   防"用户停止 vs 编排器换代"的读-改-写竞态。
 * - 每绑定线性化：start/stop 经同一 in-flight 链排队，stop 不会插进 start 的换代与
 *   spawn 之间留下孤儿 bridge；并发的重复 start 合并为同一次执行。
 * - 顺序红线（spec §3）：MEMORY 门与会话恢复都完成之前绝不启动 bridge——bridge
 *   一旦启动就会开始收到积压唤醒，顺序不能反。
 */
import type { RaftAgentBinding, RaftAgentRunState, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { AgentHomePort } from "./agentHomePorts.js";
import type { BridgeSupervisorPort } from "./bridgePorts.js";
import type { ClockPort, RaftBindingStorePort, RaftCliPort, RaftSessionPort } from "./ports.js";
import type { RaftStoreWriteLock } from "./storeLock.js";

/** 记忆门：T5 AgentHomePort 的 verifyMemoryAvailable 面（四个失败码统一收敛为 ErrorPaused(memory_unavailable)，细节进日志）。 */
export type RaftMemoryGatePort = Pick<AgentHomePort, "verifyMemoryAvailable">;

/** 锁内换代的结果：会话字段在锁内提取（闭包外的可空收窄不可靠）。 */
type StartLockResult =
  | { code: "BindingNotFound" | "NotRunningIntent" | "NoMainSession" }
  | { binding: RaftAgentBinding; sessionId: string; generation: number };

export type RaftWatchStartOutcome =
  | { ok: true }
  | {
      ok: false;
      code:
        | "BindingNotFound"
        | "NotRunningIntent"
        | "NoMainSession"
        | "MemoryUnavailable"
        | "CliUnavailable"
        | "McpUnavailable"
        | "SessionResumeFailed"
        | "BridgeStartFailed";
      detail?: string;
    };

export interface RaftWatchRuntimeOptions {
  store: RaftBindingStorePort;
  /** 必须与 RaftAgentsService 共用同一把（宿主装配负责），否则换代写与 setDesiredState 竞态。 */
  lock: RaftStoreWriteLock;
  sessions: RaftSessionPort;
  supervisor: BridgeSupervisorPort;
  cli: Pick<RaftCliPort, "resolve">;
  /** 记忆门（T5）；未注入时跳过该步——宿主接线必须补上（顺序红线）。 */
  memory?: RaftMemoryGatePort;
  /**
   * 官方宿主 MCP 具名引用（与 provisioning 同一来源，env 按 binding 派生）：
   * resume 冷恢复必须重发，缺了重建的 runtime 没有 Raft 工具。
   * 返回 undefined/空 = 插件不可用（fail-closed 不启动）。
   */
  resolveOfficialMcpServers: (binding: RaftAgentBinding) => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
  clock?: ClockPort;
  logger?: ServiceLogger;
}

export interface RaftWatchRuntime {
  /** 开始值守（幂等：已在跑则直接成功，不重复换代/不重复 drain）。 */
  startWatch(bindingId: string): Promise<RaftWatchStartOutcome>;
  /** 停止值守：等 bridge 有序退出后清覆盖层（desiredState 的落盘由调用方负责）。 */
  stopWatch(bindingId: string): Promise<void>;
  /** Host 启动恢复：desiredState=Running 的绑定逐个 startWatch，彼此独立失败。 */
  recoverAllDesiredRunning(): Promise<void>;
  /** 服务 list() 投影的运行态来源；undefined = 无运行时信息，回落 desiredState 推导。 */
  resolveRunState(binding: RaftAgentBinding): RaftAgentRunState | undefined;
  /** 有序关停（挂 Host service-dispose 阶段）：等全部 bridge 退出后清覆盖层。 */
  disposeAllAndWait(): Promise<void>;
}

/** D8 积压 drain 的幂等键：代次参与派生，重启后的 drain 不被误判为重复（spec §8.5）。 */
export function backlogDrainCommandId(bindingId: string, generation: number): string {
  return `raft-drain:${bindingId}:${generation}`;
}

/** 积压 drain 文本：值守开始的引导（无 messageId 来源头），不含任何消息正文与凭据。 */
export function buildBacklogDrainPrompt(input: { bindingId: string; generation: number; nowIso: string }): string {
  return [
    "【Raft 值守开始】值守已启动，请先处理积压消息。",
    `来源：backlog drain（值守启动，无 messageId） 绑定=${input.bindingId} 代次=${input.generation}`,
    `时间：${input.nowIso}`,
    "",
    "请依次执行：",
    "1. 用 raft_message_check 检查收件箱，处理全部未读（含值守开始前积累的积压）。",
    "2. 用 raft_message_read 读取上下文；需要回复时用 raft_message_send 明确 target 发送。",
    "3. 处理完成后静默结束；没有待办不要发无意义消息。",
  ].join("\n");
}

export function createRaftWatchRuntime(options: RaftWatchRuntimeOptions): RaftWatchRuntime {
  const logger = options.logger;
  const clock: ClockPort = options.clock ?? { nowIso: () => new Date().toISOString() };
  /** 运行态覆盖层（bindingId → ErrorPaused/Running）；仅内存，进程重启即失。 */
  const overlay = new Map<string, RaftAgentRunState>();
  /** 每绑定 in-flight 操作链：start/stop 线性化 + 并发合并。 */
  const inflight = new Map<string, Promise<unknown>>();

  function queue<T>(bindingId: string, fn: () => Promise<T>): Promise<T> {
    const prev = inflight.get(bindingId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(bindingId, settled);
    void settled.then(() => {
      if (inflight.get(bindingId) === settled) inflight.delete(bindingId);
    });
    return run;
  }

  // bridge 意外退出 → ErrorPaused(bridge_exit)；requested（stop/stopAll 主动结束）不是故障。
  options.supervisor.onExit((info) => {
    if (info.requested) return;
    overlay.set(info.bindingId, { kind: "ErrorPaused", reason: "bridge_exit" });
    logger?.error(undefined, "raft bridge exited unexpectedly", {
      bindingId: info.bindingId,
      code: info.code,
      signal: info.signal,
      stderrTail: info.stderrTail,
    });
  });

  async function doStart(bindingId: string): Promise<RaftWatchStartOutcome> {
    // 幂等入口：bridge 已在跑则不重复换代/不重复 drain。
    if (options.supervisor.isRunning(bindingId)) {
      overlay.set(bindingId, "Running");
      return { ok: true };
    }

    // CLI 是硬前置：缺失/版本不符无法拉 bridge，按异常暂停呈现并给出恢复入口。
    const resolution = await options.cli.resolve();
    if (!resolution.ok) {
      overlay.set(bindingId, { kind: "ErrorPaused", reason: "cli_unavailable" });
      logger?.warn(undefined, "raft watch start blocked: cli unavailable", {
        bindingId,
        code: resolution.code,
        detail: resolution.detail,
      });
      return { ok: false, code: "CliUnavailable", detail: resolution.detail };
    }

    const initial = (await options.store.readAll()).find((b) => b.bindingId === bindingId);
    if (!initial) {
      return { ok: false, code: "BindingNotFound" };
    }

    // MEMORY 门（spec §3：先完成记忆校验再启动 bridge，顺序不能反）。
    if (options.memory) {
      const gate = await options.memory.verifyMemoryAvailable({
        homeWorkspacePath: initial.homeWorkspacePath,
      });
      if (!gate.ok) {
        overlay.set(bindingId, { kind: "ErrorPaused", reason: "memory_unavailable" });
        logger?.warn(undefined, "raft watch start blocked: memory unavailable", {
          bindingId,
          gateCode: gate.code,
          detail: gate.detail,
        });
        return { ok: false, code: "MemoryUnavailable", detail: gate.detail ? `${gate.code}: ${gate.detail}` : gate.code };
      }
    }

    // 官方 MCP 引用（fail-closed）：resume 冷恢复必须重发；插件不可用就不启动值守
    //（没有 Raft 工具的会话收了唤醒也无法处理，fail-fast 比带病值守好）。
    const officialMcpServers = await options.resolveOfficialMcpServers(initial);
    if (officialMcpServers === undefined || officialMcpServers.length === 0) {
      // 置 ErrorPaused(mcp_unavailable)：不置值 UI 会一直投影成 Starting，用户看不到
      // 原因（评审线程 b51caf5c）；下次 startWatch 成功或 stopWatch 清除。
      overlay.set(bindingId, { kind: "ErrorPaused", reason: "mcp_unavailable" });
      logger?.warn(undefined, "raft watch start blocked: official mcp unavailable", { bindingId });
      return { ok: false, code: "McpUnavailable" };
    }

    // 锁内：重读（防 start 期间 setDesiredState）→ 校验 → 换代 → 持久化。
    const locked = await options.lock.withLock(async (): Promise<StartLockResult> => {
      const bindings = await options.store.readAll();
      const binding = bindings.find((b) => b.bindingId === bindingId);
      if (!binding) return { code: "BindingNotFound" };
      if (binding.desiredState !== "Running") return { code: "NotRunningIntent" };
      if (!binding.mainSessionRef) return { code: "NoMainSession" };
      const generation = binding.mainSessionRef.sessionGeneration + 1;
      const next: RaftAgentBinding = {
        ...binding,
        mainSessionRef: { ...binding.mainSessionRef, sessionGeneration: generation },
        updatedAt: clock.nowIso(),
      };
      await options.store.writeAll(bindings.map((b) => (b.bindingId === bindingId ? next : b)));
      return { binding: next, sessionId: binding.mainSessionRef.sessionId, generation };
    });
    if ("code" in locked) {
      logger?.info(undefined, "raft watch start aborted before spawn", { bindingId, code: locked.code });
      return { ok: false, code: locked.code };
    }

    const binding = locked.binding;
    // 清历史 ErrorPaused：本次结果以 supervisor 启动成败为准。
    overlay.delete(bindingId);

    // 会话恢复（spec §3：先于 bridge 启动）：resume 重发记忆作用域与 MCP 引用——
    // 冷恢复会重建 runtime，缺了会退回项目记忆且无 Raft 工具。失败置
    // ErrorPaused(session_unavailable)（评审线程 b51caf5c：不置值 UI 会一直显示
    // 启动中，用户看不到原因）；下次 startWatch 成功或 stopWatch 清除。
    const resumed = await options.sessions.resumeAgentSession({
      workspacePath: binding.homeWorkspacePath,
      sessionId: locked.sessionId,
      agentMemory: { homeRoot: binding.homeWorkspacePath, agentName: binding.displayName },
      officialMcpServers,
    });
    let sessionId = locked.sessionId;
    let generation = locked.generation;
    if (!resumed.ok) {
      // 会话记录随 agent 进程消亡（内嵌运行时事件存储为内存态）：ZCode 重启后
      // mainSessionRef 指向的会话不复存在（e2e S6）。Home 记忆才是持久层，主会话是
      // 可重建的运行时资源——重建并改绑（PM 批准进第一期；对话上下文丢弃、记忆保留，
      // 语义在 SPEC.md「会话恢复」小节）。新会话代次重置为 1：旧 fencing 随旧 sessionId 一起失效。
      logger?.warn(undefined, "raft watch: session resume failed, rebuilding main session", {
        bindingId,
        oldSessionId: locked.sessionId,
        reason: resumed.detail,
      });
      const created = await options.sessions.createAgentSession({
        workspacePath: binding.homeWorkspacePath,
        agentMemory: { homeRoot: binding.homeWorkspacePath, agentName: binding.displayName },
        officialMcpServers,
      });
      if (!created.ok) {
        overlay.set(bindingId, { kind: "ErrorPaused", reason: "session_unavailable" });
        logger?.warn(undefined, "raft watch start blocked: session rebuild failed", {
          bindingId,
          detail: created.detail,
        });
        return { ok: false, code: "SessionResumeFailed", detail: created.detail };
      }
      // 锁内改绑：仅在引用仍指向被替换的旧会话时写入（防与并发 start/stop 交错双写）。
      const relock = await options.lock.withLock(async (): Promise<{ ok: true } | { ok: false }> => {
        const bindings = await options.store.readAll();
        const current = bindings.find((b) => b.bindingId === bindingId);
        if (!current || current.mainSessionRef?.sessionId !== locked.sessionId) return { ok: false };
        const next: RaftAgentBinding = {
          ...current,
          mainSessionRef: { sessionId: created.sessionId, sessionGeneration: 1 },
          updatedAt: clock.nowIso(),
        };
        await options.store.writeAll(bindings.map((b) => (b.bindingId === bindingId ? next : b)));
        return { ok: true };
      });
      if (!relock.ok) {
        logger?.info(undefined, "raft watch: binding changed during session rebuild, aborting start", {
          bindingId,
        });
        return { ok: false, code: "NotRunningIntent" };
      }
      sessionId = created.sessionId;
      generation = 1;
      logger?.info(undefined, "raft watch: main session rebuilt", {
        bindingId,
        oldSessionId: locked.sessionId,
        newSessionId: created.sessionId,
      });
    }

    const started = await options.supervisor.start(
      { bindingId, profileSlug: binding.profileSlug, raftAgentId: binding.raftAgentId },
      resolution.cliPath,
    );
    if (!started.ok) {
      // NotOwner/LockHeld 是多窗口/多实例路由结果，不算本机故障，保留推导态；
      // AlreadyRunning 理论上被入口幂等挡住，兜底按已运行处理。
      if (started.code === "AlreadyRunning") {
        overlay.set(bindingId, "Running");
        return { ok: true };
      }
      if (started.code === "NotOwner" || started.code === "LockHeld") {
        logger?.info(undefined, "raft bridge start deferred to owner host", { bindingId, code: started.code });
        return { ok: false, code: "BridgeStartFailed", detail: started.code };
      }
      // EndpointUnavailable/SpawnFailed/EarlyExit → 异常暂停（spec §9）。
      overlay.set(bindingId, { kind: "ErrorPaused", reason: "bridge_exit" });
      logger?.error(undefined, "raft bridge start failed", {
        bindingId,
        code: started.code,
        detail: started.detail,
      });
      return { ok: false, code: "BridgeStartFailed", detail: started.detail ?? started.code };
    }

    overlay.set(bindingId, "Running");

    // D8 积压 drain：bridge 起来后立即投一次（无 messageId，代次幂等键）。
    const drain = await options.sessions.sendQueuedText({
      workspacePath: binding.homeWorkspacePath,
      sessionId,
      commandId: backlogDrainCommandId(bindingId, generation),
      text: buildBacklogDrainPrompt({ bindingId, generation, nowIso: clock.nowIso() }),
    });
    if (!drain.ok) {
      // bridge 已起、drain 提交失败不回滚：后续唤醒会继续投递（commandId 幂等，
      // transport/noSession 均可安全重试）；真实故障会在下一次唤醒路径暴露。
      logger?.warn(undefined, "raft backlog drain not delivered", {
        bindingId,
        generation,
        code: drain.code,
        detail: drain.detail,
      });
    } else {
      logger?.info(undefined, "raft watch started", {
        bindingId,
        generation,
        pid: started.pid,
        drainDuplicate: drain.duplicate,
      });
    }
    return { ok: true };
  }

  async function doStop(bindingId: string): Promise<void> {
    await options.supervisor.stop(bindingId);
    overlay.delete(bindingId);
  }

  return {
    startWatch(bindingId) {
      return queue(bindingId, () => doStart(bindingId));
    },
    stopWatch(bindingId) {
      return queue(bindingId, () => doStop(bindingId));
    },

    async recoverAllDesiredRunning() {
      const targets = (await options.store.readAll()).filter((b) => b.desiredState === "Running");
      const results = await Promise.allSettled(targets.map((b) => this.startWatch(b.bindingId)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        logger?.warn(undefined, "raft watch recovery had unexpected rejections", { total: targets.length, failed });
      }
    },

    resolveRunState(binding) {
      if (binding.desiredState !== "Running") return undefined;
      const pinned = overlay.get(binding.bindingId);
      if (pinned) return pinned;
      if (options.supervisor.isRunning(binding.bindingId)) return "Running";
      // 无覆盖层且 bridge 未起：Running 意图如实投影为 Starting（等编排器接管）。
      return undefined;
    },

    async disposeAllAndWait() {
      await options.supervisor.stopAll();
      overlay.clear();
    },
  };
}
