// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 把 host 的 RaftAgentsService 同步到 Agent 中心 store：挂载时加载一次，
 * 之后由绑定变更事件触发刷新，并以低频轮询兜底运行态变化（Starting→Running、异常暂停）。
 * 卸载即停止；关闭 Agent 中心不影响 host 里的值守（UI 生命周期与 Host 生命周期分离）。
 */
import { useEffect } from "react";
import type { IRaftAgentsService } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { refreshAgents } from "@/agents/agentCenterActions.js";

const POLL_INTERVAL_MS = 3000;

/** 当前环境的 RaftAgentsService；Web/远端等未装配时为 undefined。 */
export function useRaftAgentsService(): IRaftAgentsService | undefined {
  return useOptionalServices()?.raftAgentsService;
}

export function useAgentCenterSync(service: IRaftAgentsService | undefined): void {
  useEffect(() => {
    if (!service) return undefined;
    void refreshAgents(service);
    const subscription = service.onBindingsChanged(() => {
      void refreshAgents(service);
    });
    const timer = setInterval(() => {
      void refreshAgents(service);
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      subscription.dispose();
    };
  }, [service]);
}
