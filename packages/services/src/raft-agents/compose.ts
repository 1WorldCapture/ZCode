/**
 * 模块内组合根：把官方 CLI 适配器与文件存储接到服务上。
 * 宿主（node.ts createLocalServices）只经 contract.ts 拿到
 * createDefaultRaftAgentsService，不接触模块内部层级。
 */
import { getZCodeDataRootDir } from "#src/paths.js";

import { createRaftAgentsService, type RaftAgentsServiceOptions, type RaftProvisioningStep } from "./app/raftAgentsService.js";
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
