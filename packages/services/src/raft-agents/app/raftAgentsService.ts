/**
 * RaftAgentsService：绑定接入编排（spec §4 流程）。
 *
 * 状态所有者：本服务实例（host 进程内单例）。绑定记录读写只经此处；
 * renderer 通过 contract 调用，不持有第二份可写状态。
 *
 * T1 边界：createBinding 完成到 ReadyStopped 为止；不启动 bridge、
 * 不读收件箱、不发任何消息。Provisioning 的 Home/会话步骤由 T5/T3 接入，
 * 这里预留注入点（provisioningSteps），默认为空。
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import {
  raftAgentIdSchema,
  type RaftAgentBinding,
  type RaftAgentBindingInput,
  type RaftAgentListItem,
  type RaftAgentRunState,
  type RaftAgentSetupResult,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";

import type { IRaftAgentsService, RaftProvisioningStep } from "../contract.js";
import {
  deriveProfileSlug,
  findBindingConflicts,
  homePathsConflict,
  normalizeHomePathForCompare,
  normalizeRaftOrigin,
} from "../domain/binding.js";
import type { ClockPort, RaftBindingStorePort, RaftCliPort } from "./ports.js";
import { createRaftStoreWriteLock, type RaftStoreWriteLock } from "./storeLock.js";

/** Provisioning 步骤注入点：类型定义在 contract.ts（公开契约），此处只引用。 */

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
}

export function createRaftAgentsService(options: RaftAgentsServiceOptions): IRaftAgentsService {
  const { cli, store, clock } = options;
  const log = options.logger ?? createServiceLogger("raft-agents");
  const win32 = process.platform === "win32";
  const bindingsChanged = new Emitter<RaftAgentBinding[]>();
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

  /**
   * 登录成功后的失败路径清理：删除本次创建的 profile 目录，防止"无绑定记录的有效凭据"
   * 孤儿累积（slug 每次由新 bindingId 派生，重试不复用）。清理失败只记日志，
   * 不掩盖原始错误。Home 目录不在 T1 清理范围——provisioning 步骤（T5）自管其产物。
   */
  async function cleanupProfileQuietly(profileDir: string): Promise<void> {
    try {
      await cli.destroyProfile({
        profileDir,
        profilesRoot: join(options.dataRootDir, "raft", "profiles"),
      });
    } catch (error) {
      log.warn(undefined, "profile cleanup after failed setup left residue", {
        profileSlugPath: profileDir,
        error: String(error),
      });
    }
  }

  /** 表单输入的前置校验（本地、无副作用、不打网络）。 */
  function validateInput(
    input: RaftAgentBindingInput,
  ): { origin: string; homePath: string } | { error: "OriginInvalid" | "AgentIdInvalid" } {
    const origin = normalizeRaftOrigin(input.raftOrigin);
    if (origin === undefined) return { error: "OriginInvalid" };
    // 与绑定 schema 同一事实源（shared raftAgentIdSchema），杜绝两侧 UUID 语义漂移。
    if (!raftAgentIdSchema.safeParse(input.raftAgentId.trim()).success) {
      return { error: "AgentIdInvalid" };
    }
    // home 省略时用默认值（bindingId 前缀生成在调用处完成）；提供时必须绝对路径。
    if (input.homeWorkspacePath !== undefined) {
      const normalized = normalizeHomePathForCompare(input.homeWorkspacePath, { win32 });
      if (normalized === undefined) return { error: "OriginInvalid" };
      return { origin, homePath: input.homeWorkspacePath };
    }
    return { origin, homePath: "" };
  }

  function toListItem(binding: RaftAgentBinding): RaftAgentListItem {
    // 运行态优先取值守编排器覆盖层（ErrorPaused/Running，T3）；无运行时源时按意图
    // 推导（Running 意图 → Starting，等编排器接管；ReadyStopped 如实投影）。
    const runState: RaftAgentRunState =
      binding.desiredState === "Running" ? (options.resolveRunState?.(binding) ?? "Starting") : "ReadyStopped";
    return {
      bindingId: binding.bindingId,
      displayName: binding.displayName,
      raftOrigin: binding.raftOrigin,
      connectionState: "credential_ok",
      runState,
      homePath: binding.homeWorkspacePath,
    };
  }

  return {
    async list(): Promise<RaftAgentListItem[]> {
      return (await store.readAll()).map(toListItem);
    },

    async get(bindingId: string): Promise<RaftAgentBinding | null> {
      return (await store.readAll()).find((b) => b.bindingId === bindingId) ?? null;
    },

    async createBinding(input: RaftAgentBindingInput): Promise<RaftAgentSetupResult> {
      const preflight = validateInput(input);
      if ("error" in preflight) {
        // 输入形状错误按字段分流：OriginInvalid / AgentIdInvalid；homePath 形状仍归 OriginInvalid。
        return { ok: false, code: preflight.error };
      }
      const token = input.token.trim();
      if (!/^sk_agent_[A-Za-z0-9_-]+$/.test(token)) {
        return { ok: false, code: "TokenInvalid" };
      }

      // 步骤 1：CLI 检测（缺失/版本不符 → 明确报错，不自动安装）。
      const resolution = await cli.resolve();
      if (!resolution.ok) {
        return { ok: false, code: resolution.code, detail: resolution.detail };
      }

      const bindingId = randomUUID();
      const profileSlug = deriveProfileSlug(bindingId);
      const homePath =
        preflight.homePath || join(options.dataRootDir, "agents", bindingId, "workspace");
      if (!isAbsolute(homePath)) {
        return { ok: false, code: "OriginInvalid" };
      }
      const homePathForCompare = normalizeHomePathForCompare(homePath, { win32 });
      if (homePathForCompare === undefined) {
        return { ok: false, code: "OriginInvalid" };
      }
      // Home 不得包住（或落入）Raft 凭据目录：明文 sk_agent_* 在 raft/profiles 下，
      // 值守会话文件工具被锁在 Home 内（confineFileToolsToWorkspace）——若 Home 覆盖
      // 凭据目录，限制形同虚设，频道消息即可读出全部 agent 凭据（评审定稿，e2e S4）。
      const profilesRootForCompare = normalizeHomePathForCompare(
        join(options.dataRootDir, "raft", "profiles"),
        { win32 },
      );
      if (
        profilesRootForCompare !== undefined &&
        homePathsConflict(homePathForCompare, profilesRootForCompare)
      ) {
        return { ok: false, code: "HomeOverlapsCredentials" };
      }

      // 步骤 2：唯一性 fail-closed 快速路径（本地校验先于任何网络副作用；
      // 权威校验在登录后的锁内重做——那时 serverId 已知，且并发写入不会丢）。
      const preExisting = await store.readAll();
      const preConflict = findBindingConflicts(
        {
          homePathForCompare,
          profileSlug,
          raftOrigin: preflight.origin,
          serverId: "", // 登录前未知，身份级检测走下面的同源同 agent 判断。
          raftAgentId: input.raftAgentId.trim(),
        },
        preExisting,
        { win32 },
      );
      if (preConflict) {
        // 此时尚未登录，无凭据可清理。
        return { ok: false, code: preConflict.kind, detail: preConflict.conflictWith.displayName };
      }
      // 同源同 agent 已接入（serverId 未知时的强信号）：省一次登录直接指出既有绑定。
      const preDuplicate = preExisting.find(
        (b) => b.raftOrigin === preflight.origin && b.raftAgentId === input.raftAgentId.trim(),
      );
      if (preDuplicate) {
        return { ok: false, code: "AlreadyBound", detail: preDuplicate.displayName };
      }

      const profileDir = join(options.dataRootDir, "raft", "profiles", profileSlug);

      // 步骤 3：登录（token 只进 stdin）。CLI 内部自带 agentId 一致性校验。
      const login = await cli.login({
        origin: preflight.origin,
        expectedAgentId: input.raftAgentId.trim(),
        profileSlug,
        profileDir,
        token,
      });
      if (!login.ok) {
        return { ok: false, code: login.code, detail: login.detail };
      }

      // 步骤 4：whoami 二次核验 + serverId（不读 credential.json，避免 token 进应用内存）。
      // 自此起登录已成功、本地已有有效凭据：任何失败路径都要清理本次 profile。
      const whoami = await cli.whoami({ profileSlug, profileDir });
      if ("error" in whoami) {
        await cleanupProfileQuietly(profileDir);
        return { ok: false, code: "CredentialCheckFailed", detail: whoami.error };
      }
      const whoamiOrigin = normalizeRaftOrigin(whoami.serverUrl);
      if (whoami.agentId !== input.raftAgentId.trim() || whoamiOrigin !== preflight.origin) {
        await cleanupProfileQuietly(profileDir);
        return { ok: false, code: "IdentityMismatch" };
      }

      const now = clock.nowIso();
      const binding: RaftAgentBinding = {
        bindingId,
        displayName: login.agentName?.trim() || input.raftAgentId.trim(),
        raftOrigin: preflight.origin,
        serverId: whoami.serverId,
        raftAgentId: input.raftAgentId.trim(),
        profileSlug,
        homeWorkspacePath: homePath,
        mainSessionRef: null,
        desiredState: "ReadyStopped",
        autostartConsent: false,
        adapterInstance: bindingId,
        createdAt: now,
        updatedAt: now,
      };

      // 步骤 5+6：锁内权威校验与持久化。锁内重读 current——登录窗口期（最长 45s）内的
      // 并发写入不被覆盖；此刻 serverId 已知，身份重复以 AlreadyBound 拒绝。
      return withStoreLock(async () => {
        const current = await store.readAll();
        const conflict = findBindingConflicts(
          {
            homePathForCompare,
            profileSlug,
            raftOrigin: preflight.origin,
            serverId: whoami.serverId,
            raftAgentId: input.raftAgentId.trim(),
          },
          current,
          { win32 },
        );
        if (conflict) {
          const code =
            conflict.kind === "PathConflict"
              ? "PathConflict"
              : conflict.kind === "SlugConflict"
                ? "SlugConflict"
                : "AlreadyBound";
          await cleanupProfileQuietly(profileDir);
          return { ok: false as const, code, detail: conflict.conflictWith.displayName };
        }

        // Provisioning（T1 为空集/注入 no-op；各步幂等，失败可重试）。
        for (const step of provisioningSteps) {
          try {
            await step.execute(binding);
          } catch (error) {
            log.error("provisioning step failed", { step: step.name, error: String(error) });
            await cleanupProfileQuietly(profileDir);
            return { ok: false as const, code: "ProvisioningFailed" as const, detail: step.name };
          }
        }

        // 持久化（保存后即为 ReadyStopped：不启动 bridge、不读收件、不发消息）。
        try {
          await store.writeAll([...current, binding]);
        } catch (error) {
          log.error("binding store write failed", { error: String(error) });
          await cleanupProfileQuietly(profileDir);
          return { ok: false as const, code: "StoreWriteFailed" as const };
        }
        bindingsChanged.fire([...current, binding]);
        log.info("raft agent binding created", {
          bindingId,
          origin: preflight.origin,
          agentId: input.raftAgentId.trim(),
        });
        return { ok: true as const, binding };
      });
    },

    async removeBinding(bindingId: string, opts: { deleteHome: boolean }): Promise<void> {
      await withStoreLock(async () => {
        const existing = await store.readAll();
        const removed = existing.find((b) => b.bindingId === bindingId);
        const next = existing.filter((b) => b.bindingId !== bindingId);
        if (next.length === existing.length) return;
        await store.writeAll(next);
        // 本地 profile 随记录移除一并删除（凭据不留孤儿）；Raft 侧 token 不撤销（D4）。
        if (removed) {
          await cleanupProfileQuietly(
            join(options.dataRootDir, "raft", "profiles", removed.profileSlug),
          );
        }
        log.info("binding removed", { bindingId, deleteHomeRequested: opts.deleteHome });
        bindingsChanged.fire(next);
      });
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
  };
}
