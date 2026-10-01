/**
 * 模块内组合根：把官方 CLI 适配器与文件存储接到服务上。
 * 宿主（node.ts createLocalServices）从这里拿 createDefaultRaftAgentsService 与
 * createDefaultRaftHostStack（T3 宿主接线），类型契约经 contract.ts；
 * 依赖方向保持 compose → app/adapters → contract 单向。
 */
import { join } from "node:path";

import { getZCodeDataRootDir } from "#src/paths.js";

import type { IRaftAgentsService, RaftProvisioningStep } from "./contract.js";
import { createRaftActivityTracker } from "./app/activity.js";
import { createRaftAgentsService, type RaftAgentsServiceOptions } from "./app/raftAgentsService.js";
import { createRaftWakeDelivery } from "./app/wakeDelivery.js";
import { createRaftWatchRuntime, type RaftWatchRuntime } from "./app/watchRuntime.js";
import { createRaftAgentManagement } from "./app/management.js";
import type { OwnerGuardPort } from "./app/bridgePorts.js";
import type { AgentHomePort } from "./app/agentHomePorts.js";
import type { RaftSessionPort } from "./app/ports.js";
import { createRaftStoreWriteLock, type RaftStoreWriteLock } from "./app/storeLock.js";
import { createAgentHomeProvisioningStep } from "./app/agentHomeProvisioning.js";
import { buildRaftAgentToolsMcpRef } from "./app/officialMcp.js";
import { createAgentHomeAdapter } from "./adapters/agentHome.js";
import { createRaftBindingStore } from "./adapters/bindingStore.js";
import { createBridgeSupervisor } from "./adapters/bridgeSupervisor.js";
import { createRaftCliAdapter } from "./adapters/raftCli.js";
import { createRaftProfilesCatalog } from "./adapters/profilesCatalog.js";
import { createWakeServer } from "./adapters/wakeServer.js";

export interface DefaultRaftAgentsServiceOptions {
  /** 应用数据根；省略时用 getZCodeDataRootDir()。测试注入临时目录用。 */
  dataRootDir?: string;
  /** CLI 子进程的代理/自定义 CA 环境（设置页配置经 buildAgentRuntimeEnv 生成）。 */
  resolveProxyEnv?: () => Promise<Record<string, string>>;
  logger?: RaftAgentsServiceOptions["logger"];
  provisioningSteps?: RaftProvisioningStep[];
  storeWriteLock?: RaftStoreWriteLock;
  resolveRunState?: RaftAgentsServiceOptions["resolveRunState"];
  onDesiredStateChanged?: RaftAgentsServiceOptions["onDesiredStateChanged"];
}

export function createDefaultRaftAgentsService(options: DefaultRaftAgentsServiceOptions = {}) {
  const dataRootDir = options.dataRootDir ?? getZCodeDataRootDir();
  return createRaftAgentsService({
    cli: createRaftCliAdapter({ resolveProxyEnv: options.resolveProxyEnv }),
    store: createRaftBindingStore(dataRootDir),
    clock: { nowIso: () => new Date().toISOString() },
    dataRootDir,
    logger: options.logger,
    provisioningSteps: options.provisioningSteps,
    storeWriteLock: options.storeWriteLock,
    resolveRunState: options.resolveRunState,
    onDesiredStateChanged: options.onDesiredStateChanged,
    // 二期 A1 注入面：默认组合根也带上记忆/凭据枚举/活动（管理动作需要会话面，
    // 仅宿主栈装配；此处缺省不 wire management）。
    memory: createAgentHomeAdapter(),
    profilesCatalog: createRaftProfilesCatalog(join(dataRootDir, "raft", "profiles")),
    activity: createRaftActivityTracker(),
  });
}

/** 宿主接线产物：service 进 ServiceCollection，其余面由宿主在关停/启动时调用。 */
export interface RaftHostStack {
  service: IRaftAgentsService;
  runtime: RaftWatchRuntime;
  /** Host 启动后调用：恢复 desiredState=Running 的绑定（内部先等 wake server 就绪）。 */
  recoverAllDesiredRunning(): Promise<void>;
  /**
   * 有序关停（挂 Host service-dispose 阶段）：等全部 bridge 退出（supervisor.stopAll）
   * 后停 wake server。宽限期在 supervisor 内（2s < 阶段预算 3.5s）。
   */
  disposeAllAndWait(): Promise<void>;
  /** 同步收口（Host 无法 await 的路径）：强杀 bridge + best-effort 停 server。 */
  terminateAllNow(): void;
}

/**
 * T3 宿主接线组合根：一个调用装配完整值守栈——绑定服务（provisioning 注入 Home 与
 * 主会话步骤）+ 唤醒 HTTP（loopback）+ bridge supervisor + 值守编排器，共享同一把
 * 存储写锁与同一份官方 MCP 引用解析（env 按 binding 派生，不含 token）。
 *
 * 生命周期：wake server 随栈创建即启动（bridge 的 wake url 依赖它已 listen）；
 * disposeAllAndWait 由 node.ts 的 disposeServiceResourcesAndWait 调用。
 * ownerGuard 缺省恒主窗口（多窗口主窗口判定在 task #8 接入，supervisor 的
 * 进程锁已防同机双 bridge）。
 */
export function createDefaultRaftHostStack(options: {
  dataRootDir?: string;
  /** zcodeAgentService 的会话面（宿主传入 createZcodeSessionPort(zcodeAgentService)）。 */
  sessions: RaftSessionPort;
  /** 完整 AgentHomePort（initialize 供 provisioning、verifyMemoryAvailable 供值守门）。 */
  memory?: AgentHomePort;
  ownerGuard?: OwnerGuardPort;
  /** 唤醒 loopback 端口；省略随机。 */
  wakePort?: number;
  /** 收件日志保留天数（spec §7 默认 14 天，这里只透传给 MCP env）。 */
  inboxRetentionDays?: number;
  logger?: RaftAgentsServiceOptions["logger"];
  /** CLI 与 bridge 子进程共用的代理/自定义 CA 环境（设置页配置经 buildAgentRuntimeEnv 生成）。 */
  resolveProxyEnv?: () => Promise<Record<string, string>>;
}): RaftHostStack {
  const dataRootDir = options.dataRootDir ?? getZCodeDataRootDir();
  const logger = options.logger;
  const cli = createRaftCliAdapter({ resolveProxyEnv: options.resolveProxyEnv });
  const lock = createRaftStoreWriteLock();
  const store = createRaftBindingStore(dataRootDir);
  const memory = options.memory ?? createAgentHomeAdapter();
  const activity = createRaftActivityTracker();
  const profilesCatalog = createRaftProfilesCatalog(join(dataRootDir, "raft", "profiles"));

  // 官方 MCP 引用：CLI 不可解析 = 插件/环境不可用 → fail-closed（undefined）。
  const resolveOfficialMcpServers = async (binding: Parameters<typeof buildRaftAgentToolsMcpRef>[0]) => {
    const resolution = await cli.resolve();
    if (!resolution.ok) return undefined;
    return [
      buildRaftAgentToolsMcpRef(binding, {
        dataRootDir,
        cliPath: resolution.cliPath,
        ...(options.inboxRetentionDays !== undefined
          ? { inboxRetentionDays: options.inboxRetentionDays }
          : {}),
      }),
    ];
  };

  const wakeHandler = createRaftWakeDelivery({
    store,
    sessions: options.sessions,
    activity,
    logger,
  });
  const wakeServer = createWakeServer({ handler: wakeHandler, port: options.wakePort });
  const supervisor = createBridgeSupervisor({
    dataRootDir,
    wakeEndpoint: wakeServer,
    ownerGuard: options.ownerGuard ?? { isOwner: () => true },
    resolveProxyEnv: options.resolveProxyEnv,
    logger: {
      info: (message, fields) => logger?.info(undefined, message, fields),
      warn: (message, fields) => logger?.warn(undefined, message, fields),
    },
  });
  const runtime = createRaftWatchRuntime({
    store,
    lock,
    sessions: options.sessions,
    supervisor,
    cli,
    memory,
    resolveOfficialMcpServers,
    activity,
    logger,
  });

  // 二期 A1 管理动作编排：重启/重置/打开会话/删除前置拆除。
  const management = createRaftAgentManagement({
    store,
    lock,
    sessions: options.sessions,
    memory,
    runtime,
    resolveOfficialMcpServers,
    activity,
    logger,
  });

  const service = createRaftAgentsService({
    cli,
    store,
    clock: { nowIso: () => new Date().toISOString() },
    dataRootDir,
    logger,
    // 二期 A1 懒建：provisioning 只保留 Home 步骤——主会话改为首次开始值守时创建
    //（watchRuntime 懒建分支），避免空壳预建会话从未落库的角落（SPEC 更正记录）。
    provisioningSteps: [createAgentHomeProvisioningStep(memory)],
    storeWriteLock: lock,
    resolveRunState: runtime.resolveRunState,
    memory,
    profilesCatalog,
    management,
    activity,
    onDesiredStateChanged: ({ bindingId, desired }) => {
      // 状态落盘成功后触发编排（锁外、异步）：开始/停止值守。
      void (desired === "Running" ? runtime.startWatch(bindingId) : runtime.stopWatch(bindingId)).catch(
        (error) => {
          logger?.warn(undefined, "raft watch trigger failed", {
            bindingId,
            desired,
            error: String(error),
          });
        },
      );
    },
  });

  // wake server 随栈启动（bridge 的 open() 依赖已 listen；失败记日志，bridge 启动会
  // 以 EndpointUnavailable 暴露）。恢复与用户触发的 startWatch 都先等它。
  const ready = wakeServer.start().catch((error) => {
    logger?.error(undefined, "raft wake server failed to start", { error: String(error) });
  });

  return {
    service,
    runtime,
    async recoverAllDesiredRunning() {
      await ready;
      await runtime.recoverAllDesiredRunning();
    },
    async disposeAllAndWait() {
      await runtime.disposeAllAndWait();
      await wakeServer.stop();
    },
    terminateAllNow() {
      supervisor.terminateAllNow();
      void wakeServer.stop().catch(() => {});
    },
  };
}
