/**
 * 绑定接入管线（spec §4 流程，自 raftAgentsService 抽出以控制文件规模）：
 * 前置校验 → token 来源二选一（直传 / 复用本机凭据）→ CLI 检测 → 路径与唯一性
 * 守卫 → 登录（token 只进 stdin）→ whoami 身份核验 → 锁内权威校验 + provisioning
 * + 持久化。
 *
 * T1 边界：完成到 ReadyStopped 为止；不启动 bridge、不读收件箱、不发任何消息。
 * 安全不变量：token 不进日志、返回值、事件与持久化结构，只直达官方 CLI 的 stdin。
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  raftAgentIdSchema,
  type RaftAgentBinding,
  type RaftAgentBindingInput,
  type RaftAgentSetupResult,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import {
  deriveProfileSlug,
  findBindingConflicts,
  homePathsConflict,
  normalizeHomePathForCompare,
  normalizeRaftOrigin,
} from "../domain/binding.js";
import type { RaftProvisioningStep } from "../contract.js";
import { cleanupProfileQuietly } from "./profileCleanup.js";
import type {
  ClockPort,
  RaftBindingStorePort,
  RaftCliPort,
  RaftProfilesCatalogPort,
} from "./ports.js";
import type { RaftStoreWriteLock } from "./storeLock.js";

export interface RaftBindingCreateDeps {
  cli: RaftCliPort;
  store: RaftBindingStorePort;
  clock: ClockPort;
  /** 应用数据根（<ZCodeDataRoot>）；profile 与默认 Home 路径从这里派生。 */
  dataRootDir: string;
  win32: boolean;
  logger: ServiceLogger;
  /** Provisioning 步骤（幂等，失败可重试）；懒建后默认只有 Home 初始化。 */
  provisioningSteps: RaftProvisioningStep[];
  /** 本机凭据枚举（复用凭据接入的 token 来源）。 */
  profilesCatalog?: RaftProfilesCatalogPort;
  /** 与值守编排器共用的存储写锁：登录窗口期（最长 45s）内的并发写入不丢（锁内重读）。 */
  lock: RaftStoreWriteLock;
  /** 持久化成功后的绑定变更广播。 */
  emitBindingsChanged(next: RaftAgentBinding[]): void;
}

/** 表单输入的前置校验（本地、无副作用、不打网络）。 */
function validateInput(
  input: RaftAgentBindingInput,
  win32: boolean,
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

export async function createRaftAgentBinding(
  deps: RaftBindingCreateDeps,
  input: RaftAgentBindingInput,
): Promise<RaftAgentSetupResult> {
  const { cli, store, clock, logger: log } = deps;
  const preflight = validateInput(input, deps.win32);
  if ("error" in preflight) {
    // 输入形状错误按字段分流：OriginInvalid / AgentIdInvalid；homePath 形状仍归 OriginInvalid。
    return { ok: false, code: preflight.error };
  }
  // token 来源二选一（二期 A2）：直传，或复用本机已有凭据。复用时 token 从该
  // profile 的 credential.json 读出、用后即弃（不进日志/返回值）；绑定仍生成
  // 自己的 ZCode slug，原 profile 不动、不受 ZCode 删除语义波及。
  let token: string;
  if ("token" in input) {
    token = input.token.trim();
  } else {
    const occupiedBy = (await store.readAll()).find(
      (b) => b.profileSlug === input.existingProfileSlug,
    );
    if (occupiedBy) {
      return { ok: false, code: "ProfileInUse", detail: occupiedBy.displayName };
    }
    if (!deps.profilesCatalog) {
      return { ok: false, code: "CredentialCheckFailed", detail: "credential reuse not wired" };
    }
    const resolved = await deps.profilesCatalog.resolveProfileToken({
      profileSlug: input.existingProfileSlug,
    });
    if (!resolved.ok) {
      return { ok: false, code: "CredentialCheckFailed", detail: resolved.code };
    }
    token = resolved.token.trim();
  }
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
  const homePath = preflight.homePath || join(deps.dataRootDir, "agents", bindingId, "workspace");
  if (!isAbsolute(homePath)) {
    return { ok: false, code: "OriginInvalid" };
  }
  const homePathForCompare = normalizeHomePathForCompare(homePath, { win32: deps.win32 });
  if (homePathForCompare === undefined) {
    return { ok: false, code: "OriginInvalid" };
  }
  // Home 不得包住（或落入）Raft 凭据目录：明文 sk_agent_* 在 raft/profiles 下，
  // 值守会话文件工具被锁在 Home 内（confineFileToolsToWorkspace）——若 Home 覆盖
  // 凭据目录，限制形同虚设，频道消息即可读出全部 agent 凭据（评审定稿，e2e S4）。
  const profilesRootForCompare = normalizeHomePathForCompare(
    join(deps.dataRootDir, "raft", "profiles"),
    { win32: deps.win32 },
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
    { win32: deps.win32 },
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

  const profileDir = join(deps.dataRootDir, "raft", "profiles", profileSlug);
  const cleanup = (dir: string) => cleanupProfileQuietly({ cli, dataRootDir: deps.dataRootDir, logger: log }, dir);

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
    await cleanup(profileDir);
    return { ok: false, code: "CredentialCheckFailed", detail: whoami.error };
  }
  const whoamiOrigin = normalizeRaftOrigin(whoami.serverUrl);
  if (whoami.agentId !== input.raftAgentId.trim() || whoamiOrigin !== preflight.origin) {
    await cleanup(profileDir);
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
  return deps.lock.withLock(async () => {
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
      { win32: deps.win32 },
    );
    if (conflict) {
      const code =
        conflict.kind === "PathConflict"
          ? "PathConflict"
          : conflict.kind === "SlugConflict"
            ? "SlugConflict"
            : "AlreadyBound";
      await cleanup(profileDir);
      return { ok: false as const, code, detail: conflict.conflictWith.displayName };
    }

    // Provisioning（T1 为空集/注入 no-op；各步幂等，失败可重试）。
    for (const step of deps.provisioningSteps) {
      try {
        await step.execute(binding);
      } catch (error) {
        log.error("provisioning step failed", { step: step.name, error: String(error) });
        await cleanup(profileDir);
        return { ok: false as const, code: "ProvisioningFailed" as const, detail: step.name };
      }
    }

    // 持久化（保存后即为 ReadyStopped：不启动 bridge、不读收件、不发消息）。
    try {
      await store.writeAll([...current, binding]);
    } catch (error) {
      log.error("binding store write failed", { error: String(error) });
      await cleanup(profileDir);
      return { ok: false as const, code: "StoreWriteFailed" as const };
    }
    deps.emitBindingsChanged([...current, binding]);
    log.info("raft agent binding created", {
      bindingId,
      origin: preflight.origin,
      agentId: input.raftAgentId.trim(),
    });
    return { ok: true as const, binding };
  });
}
