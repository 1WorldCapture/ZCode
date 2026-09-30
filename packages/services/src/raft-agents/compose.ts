/**
 * 模块内组合根：把官方 CLI 适配器与文件存储接到服务上。
 * 宿主（node.ts createLocalServices）从这里拿 createDefaultRaftAgentsService，
 * 类型契约经 contract.ts；依赖方向保持 compose → app/adapters → contract 单向。
 */
import { getZCodeDataRootDir } from "#src/paths.js";

import type { RaftProvisioningStep } from "./contract.js";
import { createRaftAgentsService, type RaftAgentsServiceOptions } from "./app/raftAgentsService.js";
import { createRaftWakeDelivery, type RaftWakeDeliveryOptions } from "./app/wakeDelivery.js";
import type { RaftSessionPort, WakeHandlerPort } from "./app/ports.js";
import { createRaftBindingStore } from "./adapters/bindingStore.js";
import { createRaftCliAdapter } from "./adapters/raftCli.js";

type WakeDeliveryLogger = NonNullable<RaftWakeDeliveryOptions["logger"]>;

export interface DefaultRaftAgentsServiceOptions {
  /** 应用数据根；省略时用 getZCodeDataRootDir()。测试注入临时目录用。 */
  dataRootDir?: string;
  logger?: RaftAgentsServiceOptions["logger"];
  provisioningSteps?: RaftProvisioningStep[];
}

export function createDefaultRaftAgentsService(options: DefaultRaftAgentsServiceOptions = {}) {
  const dataRootDir = options.dataRootDir ?? getZCodeDataRootDir();
  return createRaftAgentsService({
    cli: createRaftCliAdapter(),
    store: createRaftBindingStore(dataRootDir),
    clock: { nowIso: () => new Date().toISOString() },
    dataRootDir,
    logger: options.logger,
    provisioningSteps: options.provisioningSteps,
  });
}

/**
 * 唤醒投递组合根（T3）：Host 侧持有 wakeServer 时把 handler 接到这里。
 * sessions 由宿主注入（createZcodeSessionPort(zcodeAgentService)）——本模块
 * 不直接依赖 zcode-agent 服务树，避免 raft-agents → 服务树的装配耦合。
 */
export function createDefaultRaftWakeDelivery(options: {
  dataRootDir?: string;
  sessions: RaftSessionPort;
  busyRetryAfterMs?: number;
  logger?: WakeDeliveryLogger;
}): WakeHandlerPort {
  const dataRootDir = options.dataRootDir ?? getZCodeDataRootDir();
  return createRaftWakeDelivery({
    store: createRaftBindingStore(dataRootDir),
    sessions: options.sessions,
    busyRetryAfterMs: options.busyRetryAfterMs,
    logger: options.logger,
  });
}
