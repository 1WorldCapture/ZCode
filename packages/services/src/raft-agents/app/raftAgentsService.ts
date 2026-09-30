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
import type {
  RaftAgentBinding,
  RaftAgentBindingInput,
  RaftAgentListItem,
  RaftAgentSetupResult,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";

import type { IRaftAgentsService } from "../contract.js";
import {
  deriveProfileSlug,
  findBindingConflicts,
  normalizeHomePathForCompare,
  normalizeRaftOrigin,
} from "../domain/binding.js";
import type { ClockPort, RaftBindingStorePort, RaftCliPort } from "./ports.js";

/** Provisioning 步骤注入点：T5（Home 初始化）/T3（主会话）按序接入，全部幂等。 */
export interface RaftProvisioningStep {
  readonly name: string;
  execute(binding: RaftAgentBinding): Promise<void>;
}

export interface RaftAgentsServiceOptions {
  cli: RaftCliPort;
  store: RaftBindingStorePort;
  clock: ClockPort;
  /** 应用数据根（<ZCodeDataRoot>）；profile 与默认 Home 路径从这里派生。 */
  dataRootDir: string;
  logger?: ServiceLogger;
  provisioningSteps?: RaftProvisioningStep[];
}

export function createRaftAgentsService(options: RaftAgentsServiceOptions): IRaftAgentsService {
  const { cli, store, clock } = options;
  const log = options.logger ?? createServiceLogger("raft-agents");
  const win32 = process.platform === "win32";
  const bindingsChanged = new Emitter<RaftAgentBinding[]>();
  const provisioningSteps = options.provisioningSteps ?? [];

  async function emitChanged(): Promise<void> {
    bindingsChanged.fire(await store.readAll());
  }

  /** 表单输入的前置校验（本地、无副作用、不打网络）。 */
  function validateInput(input: RaftAgentBindingInput): { origin: string; homePath: string } | { error: string } {
    const origin = normalizeRaftOrigin(input.raftOrigin);
    if (origin === undefined) return { error: "OriginInvalid" };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.raftAgentId.trim())) {
      return { error: "OriginInvalid" };
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
    // T1 无 bridge/会话运行时源：Running 意图如实投影为 Starting（等待 T2/T3 接管）。
    const runState = binding.desiredState === "Running" ? "Starting" : "ReadyStopped";
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
        // OriginInvalid 同时承载 agentId/homePath 的输入形状错误：文案由 UI 层区分。
        return { ok: false, code: "OriginInvalid" };
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
      const homePath = preflight.homePath || join(options.dataRootDir, "agents", bindingId, "workspace");
      if (!isAbsolute(homePath)) {
        return { ok: false, code: "OriginInvalid" };
      }
      const homePathForCompare = normalizeHomePathForCompare(homePath, { win32 });
      if (homePathForCompare === undefined) {
        return { ok: false, code: "OriginInvalid" };
      }

      // 步骤 2：唯一性 fail-closed（本地校验先于任何网络副作用）。
      const existing = await store.readAll();
      const conflict = findBindingConflicts(
        {
          homePathForCompare,
          profileSlug,
          raftOrigin: preflight.origin,
          serverId: "", // 登录前未知；身份重复检测在持久化前用 whoami 结果复核。
          raftAgentId: input.raftAgentId.trim(),
        },
        existing,
        { win32 },
      );
      if (conflict && conflict.kind === "PathConflict") {
        return { ok: false, code: "PathConflict", detail: conflict.conflictWith.displayName };
      }
      if (conflict && conflict.kind === "SlugConflict" && conflict.conflictWith.raftAgentId === input.raftAgentId.trim()
        && conflict.conflictWith.raftOrigin === preflight.origin) {
        // 同源同 agent 已接入：直接指出既有绑定。
        return { ok: false, code: "SlugConflict", detail: conflict.conflictWith.displayName };
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
      const whoami = await cli.whoami({ profileSlug, profileDir });
      if ("error" in whoami) {
        return { ok: false, code: "CredentialCheckFailed", detail: whoami.error };
      }
      const whoamiOrigin = normalizeRaftOrigin(whoami.serverUrl);
      if (whoami.agentId !== input.raftAgentId.trim() || whoamiOrigin !== preflight.origin) {
        return { ok: false, code: "IdentityMismatch" };
      }

      // 持久化前完成身份级重复检测（此时 serverId 已知）。
      const duplicate = existing.find(
        (b) =>
          b.raftOrigin === preflight.origin &&
          b.serverId === whoami.serverId &&
          b.raftAgentId === input.raftAgentId.trim(),
      );
      if (duplicate) {
        return { ok: false, code: "SlugConflict", detail: duplicate.displayName };
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

      // 步骤 5：Provisioning（T1 为空集/注入 no-op；各步幂等，失败可重试）。
      for (const step of provisioningSteps) {
        try {
          await step.execute(binding);
        } catch (error) {
          log.error("provisioning step failed", { step: step.name, error: String(error) });
          return { ok: false, code: "StoreWriteFailed", detail: step.name };
        }
      }

      // 步骤 6：持久化（保存后即为 ReadyStopped：不启动 bridge、不读收件、不发消息）。
      try {
        await store.writeAll([...existing, binding]);
      } catch (error) {
        log.error("binding store write failed", { error: String(error) });
        return { ok: false, code: "StoreWriteFailed" };
      }
      await emitChanged();
      log.info("raft agent binding created", {
        bindingId,
        origin: preflight.origin,
        agentId: input.raftAgentId.trim(),
      });
      return { ok: true, binding };
    },

    async removeBinding(bindingId: string, opts: { deleteHome: boolean }): Promise<void> {
      const existing = await store.readAll();
      const next = existing.filter((b) => b.bindingId !== bindingId);
      if (next.length === existing.length) return;
      await store.writeAll(next);
      // Home 目录与本地 profile 的删除留给注入的清理步骤（T5/T2 接管）；
      // T1 只保证记录移除。不撤销 Raft 侧 token（D4）。
      log.info("binding removed", { bindingId, deleteHomeRequested: opts.deleteHome });
      await emitChanged();
    },

    async setDesiredState(bindingId: string, desired: "ReadyStopped" | "Running"): Promise<void> {
      const existing = await store.readAll();
      let updated = false;
      const next = existing.map((b) => {
        if (b.bindingId !== bindingId) return b;
        updated = true;
        return { ...b, desiredState: desired, updatedAt: clock.nowIso() };
      });
      if (!updated) return;
      await store.writeAll(next);
      await emitChanged();
    },

    get onBindingsChanged(): Event<RaftAgentBinding[]> {
      return bindingsChanged.event;
    },
  };
}
