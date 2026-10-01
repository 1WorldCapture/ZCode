/**
 * RaftAgentsService：绑定接入编排（spec §4 流程）。
 *
 * 状态所有者：本服务实例（host 进程内单例）。绑定记录读写只经此处；
 * renderer 通过 contract 调用，不持有第二份可写状态。
 *
 * T1 边界：createBinding 完成到 ReadyStopped 为止；不启动 bridge、不读收件箱、
 * 不发任何消息。接入管线实体在 bindingCreate.ts（规模拆分），此处只做装配与委托。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import {
  raftAgentIdSchema,
  type RaftAgentBinding,
  type RaftAgentBindingInput,
  type RaftAgentListItem,
  type RaftAgentLocalCredential,
  type RaftAgentMemoryContent,
  type RaftAgentOpenSessionResult,
  type RaftAgentRemoveHomeOutcome,
  type RaftAgentRunState,
  type RaftAgentSetupResult,
  type RaftAgentStorageHealth,
  type RaftAgentVerifyCredentialInput,
  type RaftAgentVerifyResult,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";

import type { IRaftAgentsService, RaftProvisioningStep } from "../contract.js";
import { normalizeHomePathForCompare, normalizeRaftOrigin } from "../domain/binding.js";
import { RaftBindingStoreCorruptError } from "../domain/bindingStoreError.js";
import type { RaftActivityTracker } from "./activity.js";
import type { RaftActivityFeed } from "./activityFeed.js";
import { createRaftAgentBinding, defaultRaftAgentHomePath } from "./bindingCreate.js";
import { toListItem } from "./listProjection.js";
import { resolveCredentialToken } from "./credentialToken.js";
import type { AgentHomePort } from "./agentHomePorts.js";
import type { RaftAgentManagement } from "./management.js";
import { loginAndVerifyIdentity } from "./loginVerify.js";
import { cleanupProfileQuietly } from "./profileCleanup.js";
import type {
  ClockPort,
  RaftBindingStorePort,
  RaftCliPort,
  RaftProfilesCatalogPort,
} from "./ports.js";
import { createRaftStoreWriteLock, type RaftStoreWriteLock } from "./storeLock.js";

export interface RaftAgentsServiceOptions {
  cli: RaftCliPort;
  store: RaftBindingStorePort;
  clock: ClockPort;
  /** 应用数据根（<ZCodeDataRoot>）；profile 与默认 Home 路径从这里派生。 */
  dataRootDir: string;
  logger?: ServiceLogger;
  provisioningSteps?: RaftProvisioningStep[];
  /**
   * 与值守编排器（watchRuntime）共享的存储写锁：宿主装配创建一次注入两侧，
   * 保证 setDesiredState 与编排器的换代写互斥。缺省内部自建私有锁。
   */
  storeWriteLock?: RaftStoreWriteLock;
  /** 值守运行态来源（编排器 resolveRunState）：优先于 desiredState 推导（list 投影）。 */
  resolveRunState?: (binding: RaftAgentBinding) => RaftAgentRunState | undefined;
  /**
   * desiredState 持久化成功后的通知（宿主接编排器 startWatch/stopWatch）。
   * 锁外、不 await——编排是长操作（bridge 启动秒级），不阻塞状态落盘；
   * 回调内的异步与异常由宿主自行处理，同步抛错只记日志。
   */
  onDesiredStateChanged?: (params: { bindingId: string; desired: RaftAgentBinding["desiredState"] }) => void;
  /**
   * 外部注入的绑定变化 emitter（宿主栈共享）：缺省自建私有。宿主把同一只传给
   * watchRuntime/management 的 emitBindingsChanged，使换会话（懒建/重建/重启/重置/
   * 打开会话兜底/换代 +1）的落盘也广播到 onBindingsChanged——renderer 可纯事件驱动。
   */
  bindingsEmitter?: Emitter<RaftAgentBinding[]>;
  // ── 二期 A1 注入面（宿主组合根 wire；缺省退化为一期行为）──
  /** 完整 AgentHomePort：记忆只读视图 + removeBinding(deleteHome) 的 Home 删除。 */
  memory?: AgentHomePort;
  /** 本机凭据枚举（listLocalCredentials / 复用凭据接入的 token 来源）。 */
  profilesCatalog?: RaftProfilesCatalogPort;
  /** 管理动作编排（重启/重置/打开会话/删除前置拆除）。 */
  management?: RaftAgentManagement;
  /** 活动追踪（list 投影的 activity 字段；removeBinding 后清除）。 */
  activity?: RaftActivityTracker;
  /** 二期 B2：主会话活动摘要实时投影（并入 list 的 activity 字段）。 */
  feed?: Pick<RaftActivityFeed, "resolveLive" | "clear">;
}

export function createRaftAgentsService(options: RaftAgentsServiceOptions): IRaftAgentsService {
  const { cli, store, clock } = options;
  const log = options.logger ?? createServiceLogger("raft-agents");
  const win32 = process.platform === "win32";
  const bindingsChanged = options.bindingsEmitter ?? new Emitter<RaftAgentBinding[]>();
  const provisioningSteps = options.provisioningSteps ?? [];

  /**
   * 服务级写互斥：所有会写绑定记录的入口（create/remove/setDesiredState）经此串行化，
   * 写前在锁内重读，杜绝登录耗时窗口（最长 45s）内的读-改-写丢更新。
   * 注意：登录/whoami 等慢操作不持锁，锁内只有读-校验-写。
   * 锁实例可由宿主注入（与值守编排器共用同一把，防换代写竞态）；缺省私有。
   */
  const storeLock = options.storeWriteLock ?? createRaftStoreWriteLock();
  function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    return storeLock.withLock(fn);
  }

  /** profile 安静清理（绑定移除路径用；接入管线在 bindingCreate 内自带）。 */
  const cleanupProfile = (profileDir: string) =>
    cleanupProfileQuietly({ cli, dataRootDir: options.dataRootDir, logger: log }, profileDir);

  /** 接入管线依赖（bindingCreate）：与值守编排器共用 storeLock，变更经 bindingsChanged 广播。 */
  const createDeps = {
    cli,
    store,
    clock,
    dataRootDir: options.dataRootDir,
    win32,
    logger: log,
    provisioningSteps,
    profilesCatalog: options.profilesCatalog,
    lock: storeLock,
    emitBindingsChanged: (next: RaftAgentBinding[]) => bindingsChanged.fire(next),
  };

  const toItem = (binding: RaftAgentBinding): RaftAgentListItem =>
    toListItem(binding, {
      resolveRunState: options.resolveRunState,
      activity: options.activity?.resolveActivity(binding.bindingId),
      live: options.feed?.resolveLive(binding.bindingId),
    });

  return {
    async list(): Promise<RaftAgentListItem[]> {
      return (await store.readAll()).map(toItem);
    },

    /**
     * 存储健康态活探测：读一遍 store，corrupt 转形状、其他异常原样抛。
     * list() 失败后界面改调这里（专用码 + 备份路径），不必解析异常文本。
     * 备份内容寻址且排他创建，轮询重复探测不会堆积副本。
     */
    async getStorageHealth(): Promise<RaftAgentStorageHealth> {
      try {
        await store.readAll();
        return { status: "ok" };
      } catch (error) {
        if (error instanceof RaftBindingStoreCorruptError) {
          return { status: "corrupt", storePath: error.storePath, backupPath: error.backupPath ?? null };
        }
        throw error;
      }
    },

    async createBinding(input: RaftAgentBindingInput): Promise<RaftAgentSetupResult> {
      // 接入管线（spec §4）实体在 bindingCreate.ts：前置校验 → token 二选一 →
      // CLI 检测 → 唯一性守卫 → 登录 → 身份核验 → 锁内权威校验 + 持久化。
      return createRaftAgentBinding(createDeps, input);
    },

    async removeBinding(bindingId: string, opts: { deleteHome: boolean }): Promise<RaftAgentRemoveHomeOutcome> {
      // 二期 A1 删除动作前置拆除：停 bridge + session/close 归档主会话（close 失败
      // 容忍，删除语义优先）。拆除失败不阻断记录移除——桥接进程由 supervisor 的
      // 进程锁与 Host 关停兜底收口。
      if (options.management) {
        try {
          await options.management.teardownForRemoval(bindingId);
        } catch (error) {
          log.warn(undefined, "raft binding removal teardown failed (continuing)", {
            bindingId,
            error: String(error),
          });
        }
      }
      let removed: RaftAgentBinding | undefined;
      await withStoreLock(async () => {
        const existing = await store.readAll();
        removed = existing.find((b) => b.bindingId === bindingId);
        const next = existing.filter((b) => b.bindingId !== bindingId);
        if (next.length === existing.length) return;
        await store.writeAll(next);
        // 本地 profile 随记录移除一并删除（凭据不留孤儿）；Raft 侧 token 不撤销（D4）。
        if (removed) {
          await cleanupProfile(join(options.dataRootDir, "raft", "profiles", removed.profileSlug));
        }
        log.info("binding removed", { bindingId, deleteHomeRequested: opts.deleteHome });
        bindingsChanged.fire(next);
      });
      let homeOutcome: RaftAgentRemoveHomeOutcome = { home: "untouched", reason: "not_requested" };
      // Home 删除在锁外（递归 rm 可能慢）；守卫在适配器（符号链接拒绝 / 根目录与
      // 主目录上级拒删 / 归属标记或默认位置判定），归属不成立时适配器只清记忆面
      // 并保留目录——四态结果如实投影给界面。失败只记日志：记录已移除，
      // 重试入口是用户手动删目录。
      if (opts.deleteHome && removed && options.memory) {
        const deleted = await options.memory.deleteHome({
          homeWorkspacePath: removed.homeWorkspacePath,
          dataRootDir: options.dataRootDir,
          bindingId,
        });
        if (deleted.ok) {
          homeOutcome = { home: deleted.home };
        } else {
          // Refused = 守卫拒绝、Home 未动；Failed = 中途失败，Home 可能已部分删除。
          homeOutcome =
            deleted.code === "Refused"
              ? { home: "untouched", reason: "refused", ...(deleted.detail ? { detail: deleted.detail } : {}) }
              : { home: "failed", ...(deleted.detail ? { detail: deleted.detail } : {}) };
          log.warn(undefined, "raft home deletion failed", {
            bindingId,
            homePath: removed.homeWorkspacePath,
            code: deleted.code,
            detail: deleted.detail,
          });
        }
      }
      options.activity?.clear(bindingId);
      options.feed?.clear(bindingId);
      return homeOutcome;
    },

    async setDesiredState(bindingId: string, desired: "ReadyStopped" | "Running"): Promise<void> {
      let updated = false;
      await withStoreLock(async () => {
        const existing = await store.readAll();
        const next = existing.map((b) => {
          if (b.bindingId !== bindingId) return b;
          updated = true;
          return { ...b, desiredState: desired, updatedAt: clock.nowIso() };
        });
        if (!updated) return;
        await store.writeAll(next);
        bindingsChanged.fire(next);
      });
      // 持久化成功后通知（锁外、不 await）：宿主接编排器 startWatch/stopWatch；
      // 编排是长操作，不阻塞状态落盘。同步抛错只记日志（回调语义见 options 注释）。
      if (updated && options.onDesiredStateChanged) {
        try {
          options.onDesiredStateChanged({ bindingId, desired });
        } catch (error) {
          log.warn(undefined, "raft desired-state callback failed", { bindingId, error: String(error) });
        }
      }
    },

    get onBindingsChanged(): Event<RaftAgentBinding[]> {
      return bindingsChanged.event;
    },

    async verifyCredential(input: RaftAgentVerifyCredentialInput): Promise<RaftAgentVerifyResult> {
      // 与 createBinding 同族的本地前置校验（无副作用、不打网络）。
      const origin = normalizeRaftOrigin(input.raftOrigin);
      if (origin === undefined) return { ok: false, code: "OriginInvalid" };
      const agentId = input.raftAgentId.trim();
      if (!raftAgentIdSchema.safeParse(agentId).success) {
        return { ok: false, code: "AgentIdInvalid" };
      }
      // 凭据来源二选一：与 createBinding 共用 resolveCredentialToken（同一条规则，
      // 不各改各的）。核验统一走临时 verify- profile 链，用户 profile 不被触碰
      // ——两种接入模式的确认页都能先核验身份再显示（线程 bbb29be1）。
      const credential = await resolveCredentialToken(
        { store, profilesCatalog: options.profilesCatalog },
        input,
      );
      if (!credential.ok) {
        return { ok: false, code: credential.code, detail: credential.detail };
      }
      const token = credential.token;
      // 实际生效 Home（评审线程 a517415a，B1/A2 验收）：输入给了就按创建同款规则
      // 校验后回显；留空给预派发默认——绑定 UUID 创建时才生成，这里先派发一个
      // 具体路径，向导保存时作为显式输入回传（与创建共用 defaultRaftAgentHomePath）。
      let homePath: string;
      if (input.homeWorkspacePath !== undefined) {
        if (normalizeHomePathForCompare(input.homeWorkspacePath, { win32 }) === undefined) {
          return {
            ok: false,
            code: "OriginInvalid",
            detail: "homeWorkspacePath must be an absolute path",
          };
        }
        homePath = input.homeWorkspacePath;
      } else {
        homePath = defaultRaftAgentHomePath(options.dataRootDir, randomUUID());
      }
      const resolution = await cli.resolve();
      if (!resolution.ok) {
        return { ok: false, code: resolution.code, detail: resolution.detail };
      }
      // 临时 profile：verify- 前缀不进 listLocalCredentials 枚举；任何出口都即毁，
      // 无持久残留。登录→whoami→身份核验与 createBinding 共用一条链（复用审核 #11）。
      const profileSlug = `verify-${randomUUID().slice(0, 8)}`;
      const outcome = await loginAndVerifyIdentity(
        { cli, dataRootDir: options.dataRootDir, logger: log },
        {
          origin,
          expectedAgentId: agentId,
          profileSlug,
          profileDir: join(options.dataRootDir, "raft", "profiles", profileSlug),
          token,
          keepProfileOnSuccess: false,
        },
      );
      if (!outcome.ok) return outcome;
      return {
        ok: true,
        homePath,
        identity: {
          agentId: outcome.agentId,
          ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
          serverUrl: outcome.serverUrl,
          serverId: outcome.serverId,
        },
      };
    },

    async restartBinding(bindingId: string) {
      if (!options.management) {
        return { ok: false, code: "NotFound" as const, detail: "management not wired" };
      }
      return options.management.restartBinding(bindingId);
    },

    async resetBinding(bindingId: string) {
      if (!options.management) {
        return { ok: false, code: "NotFound" as const, detail: "management not wired" };
      }
      return options.management.resetBinding(bindingId);
    },

    async openAgentSession(bindingId: string): Promise<RaftAgentOpenSessionResult> {
      if (!options.management) {
        return { ok: false, code: "NotFound", detail: "management not wired" };
      }
      return options.management.openAgentSession(bindingId);
    },

    async listMemoryFiles(bindingId: string) {
      const binding = (await store.readAll()).find((b) => b.bindingId === bindingId);
      if (!binding || !options.memory) return { ok: false, code: "NotFound" as const };
      const outcome = await options.memory.listMemoryFiles({
        homeWorkspacePath: binding.homeWorkspacePath,
      });
      return outcome.ok ? { ok: true, files: outcome.files } : { ok: false, code: "NotFound" as const };
    },

    async readMemoryFile(bindingId: string, path: string): Promise<RaftAgentMemoryContent> {
      const binding = (await store.readAll()).find((b) => b.bindingId === bindingId);
      if (!binding || !options.memory) return { ok: false, code: "NotFound" };
      return options.memory.readMemoryFile({ homeWorkspacePath: binding.homeWorkspacePath, path });
    },

    async listLocalCredentials(): Promise<RaftAgentLocalCredential[]> {
      if (!options.profilesCatalog) return [];
      const [entries, bindings] = await Promise.all([
        options.profilesCatalog.list(),
        store.readAll(),
      ]);
      // boundBindingId 与 createBinding 的 ProfileInUse 兜底同判据（profileSlug 引用）。
      return entries.map((entry) => ({
        ...entry,
        boundBindingId: bindings.find((b) => b.profileSlug === entry.profileSlug)?.bindingId ?? null,
      }));
    },
  };
}
