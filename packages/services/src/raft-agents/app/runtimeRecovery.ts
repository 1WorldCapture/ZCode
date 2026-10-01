/**
 * D6：bridge 意外退出后的封顶退避重拉（宿主侧主修，方向 PM 已批）。
 *
 * 背景（2026-10-01 21:34 事故）：网络瞬断让 bridge 的重试掉出其自带退避轨道
 * （传输错误二次包装成 CHECK_FAILED 被判 fatal）→ 进程退出 → 旧实现只置
 * ErrorPaused(bridge_exit) 等人工恢复。本模块在宿主侧兜底：requested=false 的
 * 退出按 10s/30s/60s 重拉（复用值守编排的排队 startWatch，幂等 + desiredState
 * 校验 + 换代纪律原样生效）；连续 3 次失败后放弃，终态与旧实现一致
 * （ErrorPaused(bridge_exit)，界面可见原因）。requested 主动停（stop/stopAll/
 * terminateAllNow/disposeAllAndWait）不触发重拉；重拉成功或用户主动停止都会
 * 清零计数。bridge 侧分类加固（CHECK_FAILED+传输 cause → 可重试）需发新 CLI，
 * 记后续待办，不在本期。
 */
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

/** 单次重拉结局（由值守编排从 RaftWatchStartOutcome 映射，避免本模块反向依赖 watchRuntime）。 */
export type BridgeRelaunchOutcome =
  | "relaunched"
  /** desiredState 已非 Running 或绑定已删：尊重用户意图，不再重试。 */
  | "intentGone"
  /** 门失败/起进程失败等：进程没起来不会再有 onExit，由本模块推进下一档退避。 */
  | "failed";

export type BridgeScheduleFn = (delayMs: number, fn: () => void) => () => void;

export interface BridgeRecoveryOptions {
  relaunch(bindingId: string): Promise<BridgeRelaunchOutcome>;
  logger?: ServiceLogger;
  /** 调度注入口（测试确定性）；缺省 unref 的真实 setTimeout，不阻塞进程退出。 */
  schedule?: BridgeScheduleFn;
  /** 退避序列，长度即封顶次数；缺省 10s/30s/60s。 */
  backoffMs?: readonly number[];
}

export interface BridgeRecovery {
  /** 意外退出（requested=false）：安排一次重拉；同绑定已有安排或已封顶则跳过。 */
  noteUnexpectedExit(bindingId: string): void;
  /** 成功运行/主动停止/绑定移除：清零计数并取消未触发的重拉。 */
  noteSettled(bindingId: string): void;
  /** 宿主关停：取消全部重拉，此后 noteUnexpectedExit 为 no-op。 */
  dispose(): void;
}

export function createBridgeRecovery(options: BridgeRecoveryOptions): BridgeRecovery {
  const logger = options.logger;
  const backoffMs = options.backoffMs ?? [10_000, 30_000, 60_000];
  const schedule: BridgeScheduleFn =
    options.schedule ??
    ((delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.(); // 重拉调度不应挂住进程退出（disposeAllAndWait 会兜底取消）。
      return () => clearTimeout(timer);
    });

  /** 已连续失败的档位（= 已消耗的退避次数）；成功运行或主动停止才清零。 */
  const attempts = new Map<string, number>();
  const pending = new Map<string, () => void>();
  let disposed = false;

  function scheduleRelaunch(bindingId: string): void {
    const attempt = attempts.get(bindingId) ?? 0;
    if (attempt >= backoffMs.length) {
      // 封顶放弃：终态 ErrorPaused(bridge_exit) 已由 onExit 置好，界面可见原因。
      logger?.error(undefined, "raft bridge recovery gave up after capped attempts", {
        bindingId,
        attempts: backoffMs.length,
      });
      return;
    }
    const delayMs = backoffMs[attempt];
    if (delayMs === undefined) return; // 不可达（attempt < length 已保证）；仅供类型收窄。
    attempts.set(bindingId, attempt + 1);
    logger?.warn(undefined, "raft bridge relaunch scheduled", {
      bindingId,
      attempt: attempt + 1,
      delayMs,
    });
    const cancel = schedule(delayMs, () => {
      pending.delete(bindingId);
      void options
        .relaunch(bindingId)
        .then((outcome) => {
          if (outcome === "relaunched" || outcome === "intentGone") {
            attempts.delete(bindingId); // 跑起来了（下次故障从头计）或用户已改意图。
          } else {
            scheduleRelaunch(bindingId); // 没起来不会再有 onExit，自推进下一档。
          }
        })
        .catch((error: unknown) => {
          logger?.warn(undefined, "raft bridge relaunch threw unexpectedly", {
            bindingId,
            error: String(error),
          });
          scheduleRelaunch(bindingId);
        });
    });
    pending.set(bindingId, cancel);
  }

  return {
    noteUnexpectedExit(bindingId) {
      // 已有安排不叠加（同一进程只会退出一次；防御并发 onExit 重复通知）。
      if (disposed || pending.has(bindingId)) return;
      scheduleRelaunch(bindingId);
    },
    noteSettled(bindingId) {
      attempts.delete(bindingId);
      pending.get(bindingId)?.();
      pending.delete(bindingId);
    },
    dispose() {
      disposed = true;
      for (const cancel of pending.values()) cancel();
      pending.clear();
      attempts.clear();
    },
  };
}
