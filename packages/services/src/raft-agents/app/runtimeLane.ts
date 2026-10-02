// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 值守运行态执行道（从 watchRuntime 按职责拆出，收尾架构压行）：
 * - in-flight 链把 start/stop/管理动作按绑定线性化，并发重复调用合并（同绑定
 *   两次并发 startWatch 只执行一次链路）；
 * - 运行态覆盖层（ErrorPaused/Running）只存内存，叠加在 desiredState 之上供
 *   list() 投影，下次 startWatch 成功或 stopWatch 清除，进程重启即失（spec §9）。
 */
import type { RaftAgentRunState } from "@zcode/shared";

export interface RaftRuntimeLane {
  /** 按绑定线性化：fn 排在既有操作之后执行；返回值/异常原样透传给调用方。 */
  queue<T>(bindingId: string, fn: () => Promise<T>): Promise<T>;
  /** 运行态覆盖层（内存投影，见模块注释）。 */
  readonly overlay: {
    get(bindingId: string): RaftAgentRunState | undefined;
    set(bindingId: string, state: RaftAgentRunState): void;
    delete(bindingId: string): void;
    clear(): void;
  };
}

export function createRaftRuntimeLane(): RaftRuntimeLane {
  const overlay = new Map<string, RaftAgentRunState>();
  const inflight = new Map<string, Promise<unknown>>();

  function queue<T>(bindingId: string, fn: () => Promise<T>): Promise<T> {
    const prev = inflight.get(bindingId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(() => undefined, () => undefined);
    inflight.set(bindingId, settled);
    void settled.then(() => {
      if (inflight.get(bindingId) === settled) inflight.delete(bindingId);
    });
    return run;
  }

  return {
    queue,
    overlay: {
      get: (bindingId) => overlay.get(bindingId),
      set: (bindingId, state) => void overlay.set(bindingId, state),
      delete: (bindingId) => void overlay.delete(bindingId),
      clear: () => void overlay.clear(),
    },
  };
}
