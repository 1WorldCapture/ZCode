/**
 * 模块内组合根：把官方 CLI 适配器与文件存储接到服务上。
 * 宿主（node.ts createLocalServices）从这里拿 createDefaultRaftAgentsService，
 * 类型契约经 contract.ts；依赖方向保持 compose → app/adapters → contract 单向。
 */
import { getZCodeDataRootDir } from "#src/paths.js";

import type { RaftProvisioningStep } from "./contract.js";
import { createRaftAgentsService, type RaftAgentsServiceOptions } from "./app/raftAgentsService.js";
import { createRaftBindingStore } from "./adapters/bindingStore.js";
import { createRaftCliAdapter } from "./adapters/raftCli.js";

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
