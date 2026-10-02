// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 值守编排（T3）：把"开始/停止值守"意图变成 bridge 生命周期 + 会话换代 + 积压 drain。
 * 链路（spec §3 + §8.5 D8）：前置门（watchStartGates：CLI→MEMORY 门→官方 MCP，
 * fail-closed）→ 锁内换代 → 会话恢复/懒建（sessionSwap 共享段）→ supervisor.start
 * → D8 积压 drain（commandId 按 bindingId+启动代次派生，重启后不误判重复）。
 *
 * 设计要点：ErrorPaused/Running 覆盖层只存内存（runtimeLane；list() 投影叠加在
 * desiredState 之上，下次 startWatch 成功或 stopWatch 清除）；换代在锁内（与
 * RaftAgentsService 共用 storeWriteLock，防"用户停止 vs 编排器换代"竞态）；start/
 * stop 经同一 in-flight 链每绑定线性化（并发重复 start 合并）；顺序红线——MEMORY
 * 门与会话恢复都完成之前绝不启动 bridge。bridge 意外退出置 ErrorPaused(bridge_exit)
 * 并触发 D6 封顶退避重拉（runtimeRecovery，spec §9）；requested 主动停不是故障。
 * D8：bridge 首次启动的故障失败（EarlyExit 含 BRIDGE_ALREADY_RUNNING 孤儿锁、
 * SpawnFailed、EndpointUnavailable）同链路封顶重拉——进程没起来不会再有 onExit。
 */
import type { RaftAgentBinding, RaftAgentRunState, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftActivityTracker } from "./activity.js";
import type { BridgeSupervisorPort } from "./bridgePorts.js";
import { createRaftRuntimeLane } from "./runtimeLane.js";
import { createBridgeRecovery, type BridgeScheduleFn } from "./runtimeRecovery.js";
import { backlogDrainCommandId, buildBacklogDrainPrompt } from "./prompts.js";
import type { ClockPort, RaftBindingStorePort, RaftCliPort, RaftSessionPort } from "./ports.js";
import { resolveMainSessionForStart } from "./sessionSwap.js";
import type { RaftStoreWriteLock } from "./storeLock.js";
import { runWatchStartGates, type RaftMemoryGatePort } from "./watchStartGates.js";

export type { RaftMemoryGatePort };

/**
 * 锁内换代的结果：会话字段在锁内提取（闭包外的可空收窄不可靠）。
 * LazySessionCreate（二期 A1）：mainSessionRef 为空——预建会话改为首次开始才创建，
 * 锁内只确认意图，创建在锁外完成后再条件改绑（与 resume 失败的重建分支同构）。
 */
type StartLockResult =
  | { code: "BindingNotFound" | "NotRunningIntent" }
  | { code: "LazySessionCreate"; binding: RaftAgentBinding }
  | { binding: RaftAgentBinding; sessionId: string; generation: number };

export type RaftWatchStartOutcome =
  | { ok: true }
  | {
      ok: false;
      code:
        | "BindingNotFound"
        | "NotRunningIntent"
        /** 懒建路径的 createAgentSession 失败（原 NoMainSession 语义已被懒建取代）。 */
        | "SessionCreateFailed"
        | "MemoryUnavailable"
        | "CliUnavailable"
        | "McpUnavailable"
        | "LegacyWatchHeld"
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
   * 双消费保险之三（grokbot 复核第 3 条）：并排身份（TinyCode）启动绑定前只读探测
   * 旧产品侧值守锁，存活值守即 ErrorPaused(legacy_watch_held) 拒绝启动。同产品形态
   * 由组合根注入 undefined。
   */
  legacyWatchProbe?: { isWatchHeld: (bindingId: string) => Promise<boolean> };
  /**
   * 官方宿主 MCP 具名引用（与 provisioning 同一来源，env 按 binding 派生）：
   * resume 冷恢复必须重发，缺了重建的 runtime 没有 Raft 工具。
   * 返回 undefined/空 = 插件不可用（fail-closed 不启动）。
   */
  resolveOfficialMcpServers: (binding: RaftAgentBinding) => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
  /** 二期 A1：活动追踪（drain 提交 / 记忆门结果 / 值守失败）。 */
  activity?: RaftActivityTracker;
  feed?: import("./activityFeed.js").RaftActivityFeed; // 二期 B2 活动摘要（会话订阅、bridge 连接、待处理计数）
  clock?: ClockPort;
  logger?: ServiceLogger;
  /** 主会话编号变化广播（与 onBindingsChanged 同源；懒建/重建/换代 +1 落盘后 fire）。 */
  emitBindingsChanged?: (next: RaftAgentBinding[]) => void;
  /** D6 重拉调度注入口（测试确定性）；缺省 unref 的真实 setTimeout。 */
  schedule?: BridgeScheduleFn;
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
  /**
   * 二期 A1：管理动作（重启/重置/删除）的独占执行段——与 start/stop 同链线性化，
   * 保证"停 bridge → 换会话 → 重启"不与用户开始/停止交错。fn 内禁止调用排队版
   * startWatch/stopWatch（会排在自身之后造成永久挂起）；需要停 bridge 用 stopBridgeNow。
   */
  runExclusive<T>(bindingId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * 二期 A1：立即停止单个 bridge 并清覆盖层（不排队）——仅供 runExclusive 段内使用；
   * 外部调用方应使用排队版 stopWatch。
   */
  stopBridgeNow(bindingId: string): Promise<void>;
  /** 唤醒自愈失败时置 ErrorPaused(session_unavailable)（界面可见；只动覆盖层，幂等）。 */
  markSessionUnavailable(bindingId: string): void;
}


export function createRaftWatchRuntime(options: RaftWatchRuntimeOptions): RaftWatchRuntime {
  const logger = options.logger;
  const clock: ClockPort = options.clock ?? { nowIso: () => new Date().toISOString() };
  const lane = createRaftRuntimeLane();

  // D6 封顶退避重拉：relaunch 走与 startWatch 相同的排队链（幂等 + 锁内 desiredState
  // 校验 + 换代纪律全部原样生效）。用户意图已变（停止/删除）映射 intentGone 不再重试。
  const recovery = createBridgeRecovery({
    relaunch: (bindingId) =>
      lane.queue(bindingId, () => doStart(bindingId)).then((outcome) => {
        if (outcome.ok) return "relaunched";
        if (outcome.code === "NotRunningIntent" || outcome.code === "BindingNotFound") return "intentGone";
        return "failed";
      }),
    logger,
    schedule: options.schedule,
  });

  function markRunning(bindingId: string) {
    lane.overlay.set(bindingId, "Running");
    recovery.noteSettled(bindingId); // 跑起来了：本轮恢复结束，D6 计数清零。
  }

  // bridge 意外退出 → ErrorPaused(bridge_exit) + D6 退避重拉；requested（stop/
  // stopAll 主动结束）不是故障。
  options.supervisor.onExit((info) => {
    if (info.requested) return;
    lane.overlay.set(info.bindingId, { kind: "ErrorPaused", reason: "bridge_exit" });
    options.activity?.record(info.bindingId, "error");
    logger?.error(undefined, "raft bridge exited unexpectedly", {
      bindingId: info.bindingId,
      code: info.code,
      signal: info.signal,
      stderrTail: info.stderrTail,
    });
    recovery.noteUnexpectedExit(info.bindingId);
  });

  async function doStart(bindingId: string): Promise<RaftWatchStartOutcome> {
    // 幂等入口：bridge 已在跑则不重复换代/不重复 drain。
    if (options.supervisor.isRunning(bindingId)) {
      markRunning(bindingId);
      return { ok: true };
    }

    // 前置门（spec §3 顺序红线，watchStartGates）：CLI → MEMORY 门 → 官方 MCP（fail-closed）。
    // 带 reason 的失败置 ErrorPaused 呈现原因（b51caf5c：不置值 UI 会一直投影成 Starting）。
    const gates = await runWatchStartGates(
      {
        cli: options.cli,
        memory: options.memory,
        legacyWatchProbe: options.legacyWatchProbe,
        store: options.store,
        resolveOfficialMcpServers: options.resolveOfficialMcpServers,
        activity: options.activity,
        logger,
      },
      bindingId,
    );
    if (!gates.ok) {
      if (!("reason" in gates.failure)) return { ok: false, code: gates.failure.code };
      lane.overlay.set(bindingId, { kind: "ErrorPaused", reason: gates.failure.reason });
      return { ok: false, code: gates.failure.code, detail: gates.failure.detail };
    }
    const officialMcpServers = gates.officialMcpServers;

    // 锁内：重读（防 start 期间 setDesiredState）→ 校验 → 换代 → 持久化。
    const locked = await options.lock.withLock(async (): Promise<StartLockResult> => {
      const bindings = await options.store.readAll();
      const binding = bindings.find((b) => b.bindingId === bindingId);
      if (!binding) return { code: "BindingNotFound" };
      if (binding.desiredState !== "Running") return { code: "NotRunningIntent" };
      // 二期 A1 懒建：无预建会话不再失败，改走锁外创建 + 条件改绑。
      if (!binding.mainSessionRef) return { code: "LazySessionCreate", binding };
      const generation = binding.mainSessionRef.sessionGeneration + 1;
      const next: RaftAgentBinding = {
        ...binding,
        mainSessionRef: { ...binding.mainSessionRef, sessionGeneration: generation },
        updatedAt: clock.nowIso(),
      };
      const nextAll = bindings.map((b) => (b.bindingId === bindingId ? next : b));
      await options.store.writeAll(nextAll);
      // 代次 +1 同属主会话编号变化（写入成功后广播；sessionId 未变，界面按需判等）。
      options.emitBindingsChanged?.(nextAll);
      return { binding: next, sessionId: binding.mainSessionRef.sessionId, generation };
    });
    if ("code" in locked && locked.code !== "LazySessionCreate") {
      logger?.info(undefined, "raft watch start aborted before spawn", { bindingId, code: locked.code });
      return { ok: false, code: locked.code };
    }

    const binding = locked.binding;
    // 清历史 ErrorPaused：本次结果以会话解析与 supervisor 启动成败为准。
    lane.overlay.delete(bindingId);

    // 会话恢复/懒建（sessionSwap 共享段，顺序红线：完成之前绝不 spawn）。
    const session = await resolveMainSessionForStart(
      {
        store: options.store,
        lock: options.lock,
        sessions: options.sessions,
        clock,
        emitBindingsChanged: options.emitBindingsChanged,
        logger,
      },
      {
        binding,
        mode:
          "code" in locked
            ? { kind: "lazy" }
            : { kind: "resume", sessionId: locked.sessionId, generation: locked.generation },
        officialMcpServers,
      },
    );
    if (!session.ok) {
      if (session.code === "not-intent") {
        logger?.info(undefined, "raft watch: binding changed during session resolve, aborting start", { bindingId });
        return { ok: false, code: "NotRunningIntent" };
      }
      lane.overlay.set(bindingId, { kind: "ErrorPaused", reason: "session_unavailable" });
      options.activity?.record(bindingId, "error");
      logger?.warn(
        undefined,
        session.code === "create-failed"
          ? "raft watch start blocked: lazy session create failed"
          : "raft watch start blocked: session rebuild failed",
        { bindingId, detail: session.detail },
      );
      return {
        ok: false,
        code: session.code === "create-failed" ? "SessionCreateFailed" : "SessionResumeFailed",
        detail: session.detail,
      };
    }
    const { sessionId, generation } = session;

    const started = await options.supervisor.start(
      { bindingId, profileSlug: binding.profileSlug, raftAgentId: binding.raftAgentId },
      gates.cliPath,
    );
    if (!started.ok) {
      // NotOwner/LockHeld 是多窗口/多实例路由结果，不算本机故障，保留推导态；
      // AlreadyRunning 理论上被入口幂等挡住，兜底按已运行处理。
      if (started.code === "AlreadyRunning") {
        markRunning(bindingId);
        return { ok: true };
      }
      if (started.code === "NotOwner" || started.code === "LockHeld") {
        logger?.info(undefined, "raft bridge start deferred to owner host", { bindingId, code: started.code });
        return { ok: false, code: "BridgeStartFailed", detail: started.code };
      }
      // EndpointUnavailable/SpawnFailed/EarlyExit → 异常暂停（spec §9）。
      lane.overlay.set(bindingId, { kind: "ErrorPaused", reason: "bridge_exit" });
      options.activity?.record(bindingId, "error");
      logger?.error(undefined, "raft bridge start failed", {
        bindingId,
        code: started.code,
        detail: started.detail,
      });
      // D8：首启故障（EarlyExit 含 BRIDGE_ALREADY_RUNNING 孤儿锁等暂态）同样进入
      // 封顶退避重拉——进程没起来不会再有 onExit；NotOwner/LockHeld 是多窗口
      // 路由结果（上面已 defer），不属本机故障，不走这里。
      recovery.noteStartFailure(bindingId);
      return { ok: false, code: "BridgeStartFailed", detail: started.detail ?? started.code };
    }

    markRunning(bindingId);
    options.feed?.attach(bindingId, { workspacePath: binding.homeWorkspacePath, sessionId });

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
      options.activity?.record(bindingId, "drain_submitted");
      options.feed?.noteWakeAccepted(bindingId);
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
    recovery.noteSettled(bindingId); // 主动停：取消任何未触发的 D6 重拉。
    options.feed?.detach(bindingId, { bridgeWasRunning: options.supervisor.isRunning(bindingId) }); // B2
    await options.supervisor.stop(bindingId);
    lane.overlay.delete(bindingId);
  }

  return {
    startWatch(bindingId) {
      return lane.queue(bindingId, () => doStart(bindingId));
    },
    stopWatch(bindingId) {
      return lane.queue(bindingId, () => doStop(bindingId));
    },

    async recoverAllDesiredRunning() {
      let targets;
      try {
        targets = (await options.store.readAll()).filter((b) => b.desiredState === "Running");
      } catch (error) {
        // 存储损坏 fail-closed：不拉起任何 bridge（值守暂停），错误进日志等用户恢复
        //（绑定文件损坏时报错并暂停值守，审核报告 D3）。
        logger?.warn(undefined, "raft watch recovery skipped: bindings store unreadable", {
          error: String(error),
        });
        return;
      }
      const results = await Promise.allSettled(targets.map((b) => this.startWatch(b.bindingId)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        logger?.warn(undefined, "raft watch recovery had unexpected rejections", { total: targets.length, failed });
      }
    },

    resolveRunState(binding) {
      if (binding.desiredState !== "Running") return undefined;
      const pinned = lane.overlay.get(binding.bindingId);
      if (pinned) return pinned;
      if (options.supervisor.isRunning(binding.bindingId)) return "Running";
      // 无覆盖层且 bridge 未起：Running 意图如实投影为 Starting（等编排器接管）。
      return undefined;
    },

    async disposeAllAndWait() {
      recovery.dispose(); // 先取消全部 D6 重拉：关停期间/之后不再有自动拉起。
      await options.supervisor.stopAll();
      lane.overlay.clear();
    },

    runExclusive(bindingId, fn) {
      return lane.queue(bindingId, fn);
    },

    async stopBridgeNow(bindingId) {
      await doStop(bindingId);
    },

    markSessionUnavailable(bindingId) {
      const pinned = lane.overlay.get(bindingId);
      if (pinned && pinned !== "Running") return; // 已暂停则保留首个故障原因
      lane.overlay.set(bindingId, { kind: "ErrorPaused", reason: "session_unavailable" });
      options.activity?.record(bindingId, "error");
      logger?.error(undefined, "raft watch: main session unrecoverable, paused", { bindingId });
    },
  };
}
