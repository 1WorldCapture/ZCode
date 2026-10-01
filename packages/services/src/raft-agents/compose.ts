/**
 * 模块内组合根：把官方 CLI 适配器与文件存储接到服务上。
 * 宿主（node.ts createLocalServices）从这里拿 createDefaultRaftAgentsService 与
 * createDefaultRaftHostStack（T3 宿主接线），类型契约经 contract.ts；
 * 依赖方向保持 compose → app/adapters → contract 单向。
 */
import { join } from "node:path";

import { Emitter } from "@zcode/rpc";
import type { RaftAgentBinding } from "@zcode/shared";

import { getZCodeDataRootDir } from "#src/paths.js";

import type { IRaftAgentsService, RaftProvisioningStep } from "./contract.js";
import { createRaftActivityTracker } from "./app/activity.js";
import { createRaftActivityFeed } from "./app/activityFeed.js";
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
import { createRaftProfilesCatalog, resolveSlockHome } from "./adapters/profilesCatalog.js";
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
    profilesCatalog: createRaftProfilesCatalog(join(dataRootDir, "raft", "profiles"), { slockHome: resolveSlockHome() }),
    activity: createRaftActivityTracker(),
  });
}

/**
 * 宿主接线产物：service 进 ServiceCollection（disposeAll/disposeAllAndWait 随服务
 * 对象走通用关停链），恢复由宿主在启动时调用。
 */
export interface RaftHostStack {
  /** 绑定服务 + 栈级关停面（disposeAll 强杀收口 / disposeAllAndWait 有序关停）。 */
  service: IRaftAgentsService & RaftStackDisposable;
  runtime: RaftWatchRuntime;
  /** Host 启动后调用：恢复 desiredState=Running 的绑定（内部先等 wake server 就绪）。 */
  recoverAllDesiredRunning(): Promise<void>;
}

/** 栈级关停面：挂进 node.ts 的 disposeServiceResources(AndWait) 通用列表。 */
export interface RaftStackDisposable {
  /**
   * 有序关停（Host service-dispose 阶段）：等全部 bridge 退出（supervisor.stopAll）
   * 后停 wake server。宽限期在 supervisor 内（2s < 阶段预算 3.5s）。
   */
  disposeAllAndWait(): Promise<void>;
  /** 同步收口（Host 无法 await 的路径）：强杀 bridge + best-effort 停 server。 */
  disposeAll(): void;
}

/**
 * T3 宿主接线组合根：一个调用装配完整值守栈——绑定服务（provisioning 注入 Home 与
 * 主会话步骤）+ 唤醒 HTTP（loopback）+ bridge supervisor + 值守编排器，共享同一把
 * 存储写锁与同一份官方 MCP 引用解析（env 按 binding 派生，不含 token）。
 *
 * 生命周期：wake server 随栈创建即启动（bridge 的 wake url 依赖它已 listen）；
 * 关停面（disposeAllAndWait / disposeAll）挂在 service 对象上，由 node.ts 的
 * disposeServiceResources(AndWait) 通用服务列表统一收口（经 hasDisposeAll(AndWait)
 * 结构识别，与 terminal/bots 等服务同链）。
 * ownerGuard 缺省恒主窗口（多窗口主窗口判定在 task #8 接入，supervisor 的
 * 进程锁已防同机双 bridge）。
 */
export function createDefaultRaftHostStack(options: {
  dataRootDir?: string;
  /** 任务门面的会话面（宿主传入 createZcodeSessionPort(zcodeTaskService)）。 */
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
  // 共享绑定变化 emitter：service 的 onBindingsChanged 与换会话写入（懒建/重建/
  // 重启/重置/打开会话兜底/换代 +1）经同一只广播，renderer 可纯事件驱动。
  const bindingsChanged = new Emitter<RaftAgentBinding[]>();
  const emitBindingsChanged = (next: RaftAgentBinding[]): void => {
    try {
      bindingsChanged.fire(next);
    } catch (error) {
      // 监听器异常不应冒充换会话失败：此刻新会话已建、改绑已落盘（复核意见）。
      logger?.warn(undefined, "raft bindings-changed listener failed (tolerated)", { error: String(error) });
    }
  };
  const cli = createRaftCliAdapter({ resolveProxyEnv: options.resolveProxyEnv });
  const lock = createRaftStoreWriteLock();
  const store = createRaftBindingStore(dataRootDir);
  const memory = options.memory ?? createAgentHomeAdapter();
  const activity = createRaftActivityTracker();
  // 二期 B2：主会话活动摘要（会话事件 → Raft 活动转发缓冲 + 本机实时投影）。
  const feed = createRaftActivityFeed({ sessions: options.sessions, logger });
  const profilesCatalog = createRaftProfilesCatalog(join(dataRootDir, "raft", "profiles"), { slockHome: resolveSlockHome() });

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
    // targetLost 自愈（R4 评审定稿）：MCP 引用与值守/管理同一来源；恢复失败经
    // 值守层覆盖层置 ErrorPaused(session_unavailable)。runtime 在下方才创建，
    // 回调用箭头惰性引用（唤醒发生时必已初始化）。
    resolveOfficialMcpServers,
    onSessionUnrecoverable: (bindingId) => runtime.markSessionUnavailable(bindingId),
    feed,
    logger,
  });
  const wakeServer = createWakeServer({ handler: wakeHandler, port: options.wakePort, activity: feed });
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
  // B2：bridge 意外退出记一次断开（requested 由 stopWatch 经 feed.detach 记）。
  supervisor.onExit((info) => {
    if (!info.requested) feed.noteBridge(info.bindingId, "disconnected", "bridge_exit");
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
    feed,
    logger,
    emitBindingsChanged,
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
    emitBindingsChanged,
  });

  const service = createRaftAgentsService({
    cli,
    store,
    clock: { nowIso: () => new Date().toISOString() },
    dataRootDir,
    logger,
    bindingsEmitter: bindingsChanged,
    // 二期 A1 懒建：provisioning 只保留 Home 步骤——主会话改为首次开始值守时创建
    //（watchRuntime 懒建分支），避免空壳预建会话从未落库的角落（SPEC 更正记录）。
    provisioningSteps: [createAgentHomeProvisioningStep(memory)],
    storeWriteLock: lock,
    resolveRunState: runtime.resolveRunState,
    memory,
    profilesCatalog,
    management,
    activity,
    feed,
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
    // 栈级关停面挂进服务对象：node.ts 经 ServiceCollection 通用 dispose 列表收口，
    // 无需宿主侧表（原 raftHostStacks WeakMap 已删）。
    service: Object.assign(service, {
      disposeAllAndWait: async () => {
        // best-effort（与原宿主侧表调用同语义）：单栈关停失败不阻断通用列表里
        // 后续服务的收口（那里失败会让 agent 进程树变孤儿）。
        try {
          await runtime.disposeAllAndWait();
          feed.disposeAll();
          await wakeServer.stop();
        } catch (error) {
          logger?.warn(undefined, "raft stack disposeAllAndWait failed (tolerated)", {
            error: String(error),
          });
        }
      },
      disposeAll: () => {
        supervisor.terminateAllNow();
        feed.disposeAll();
        void wakeServer.stop().catch(() => {});
      },
    } satisfies RaftStackDisposable),
    runtime,
    async recoverAllDesiredRunning() {
      await ready;
      await runtime.recoverAllDesiredRunning();
    },
  };
}
