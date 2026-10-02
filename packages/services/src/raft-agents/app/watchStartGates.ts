// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 值守启动前置门（spec §3 顺序红线，自 watchRuntime 抽出）：CLI 就绪 → 绑定在档
 * →（并排身份时）旧产品值守锁探测 → MEMORY 门（T5 verifyMemoryAvailable）→ 官方
 * MCP 引用解析（fail-closed）。任一失败即返回失败（调用方按 reason 置 ErrorPaused
 * 呈现原因，评审线程 b51caf5c），全程不碰 bridge——MEMORY 门与 MCP 未过之前绝不
 * 启动 bridge，顺序不能反。
 */
import type { RaftAgentBinding, ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftActivityTracker } from "./activity.js";
import type { AgentHomePort } from "./agentHomePorts.js";
import type { RaftBindingStorePort, RaftCliPort } from "./ports.js";

/** 记忆门：T5 AgentHomePort 的 verifyMemoryAvailable 面（四个失败码统一收敛为 ErrorPaused(memory_unavailable)，细节进日志）。 */
export type RaftMemoryGatePort = Pick<AgentHomePort, "verifyMemoryAvailable">;

/** 前置门失败：带 reason 的进 ErrorPaused 覆盖层；BindingNotFound 是非故障，不置值。 */
export type RaftStartGateFailure =
  | { code: "BindingNotFound" }
  | {
      code: "CliUnavailable" | "MemoryUnavailable" | "McpUnavailable" | "LegacyWatchHeld";
      /** ErrorPaused 的呈现原因（cli_unavailable / memory_unavailable / mcp_unavailable / legacy_watch_held）。 */
      reason: "cli_unavailable" | "memory_unavailable" | "mcp_unavailable" | "legacy_watch_held";
      detail?: string;
    };

export type RaftStartGateOutcome =
  | {
      ok: true;
      cliPath: string;
      binding: RaftAgentBinding;
      officialMcpServers: ZCodeOfficialMcpServerRef[];
    }
  | { ok: false; failure: RaftStartGateFailure };

export interface RaftStartGateDeps {
  cli: Pick<RaftCliPort, "resolve">;
  /** 记忆门（T5）；未注入时跳过该步——宿主接线必须补上（顺序红线）。 */
  memory?: RaftMemoryGatePort;
  store: RaftBindingStorePort;
  /**
   * 双消费保险之三（grokbot 复核第 3 条）：并排身份（TinyCode）启动任何绑定前，
   * 只读探测旧产品（~/.zcode）侧同一 bindingId 的值守锁——存活值守即拒绝启动。
   * 未注入（同产品形态）跳过；探测异常 fail-open 记日志（源根缺失是常态）。
   */
  legacyWatchProbe?: { isWatchHeld: (bindingId: string) => Promise<boolean> };
  /**
   * 官方宿主 MCP 具名引用（与 provisioning 同一来源，env 按 binding 派生）：
   * resume 冷恢复必须重发，缺了重建的 runtime 没有 Raft 工具。
   * 返回 undefined/空 = 插件不可用（fail-closed 不启动）。
   */
  resolveOfficialMcpServers: (binding: RaftAgentBinding) => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
  activity?: RaftActivityTracker;
  logger?: ServiceLogger;
}

export async function runWatchStartGates(deps: RaftStartGateDeps, bindingId: string): Promise<RaftStartGateOutcome> {
  // CLI 是硬前置：缺失/版本不符无法拉 bridge，按异常暂停呈现并给出恢复入口。
  const resolution = await deps.cli.resolve();
  if (!resolution.ok) {
    deps.activity?.record(bindingId, "error");
    deps.logger?.warn(undefined, "raft watch start blocked: cli unavailable", {
      bindingId,
      code: resolution.code,
      detail: resolution.detail,
    });
    return {
      ok: false,
      failure: { code: "CliUnavailable", reason: "cli_unavailable", detail: resolution.detail },
    };
  }

  const binding = (await deps.store.readAll()).find((b) => b.bindingId === bindingId);
  if (!binding) {
    return { ok: false, failure: { code: "BindingNotFound" } };
  }

  // 双消费保险之三：旧产品侧存活值守（同 bindingId 持锁）即拒绝启动——两边同时
  // 值守会争抢收件箱。fail-open 只限探测本身异常（旧根不存在是全新机器常态）。
  if (deps.legacyWatchProbe) {
    let held = false;
    try {
      held = await deps.legacyWatchProbe.isWatchHeld(bindingId);
    } catch (error) {
      deps.logger?.warn(undefined, "raft legacy watch probe failed (fail-open)", {
        bindingId,
        error: String(error),
      });
    }
    if (held) {
      deps.activity?.record(bindingId, "error");
      deps.logger?.warn(undefined, "raft watch start blocked: legacy product is watching the same binding", {
        bindingId,
        displayName: binding.displayName,
      });
      return {
        ok: false,
        failure: {
          code: "LegacyWatchHeld",
          reason: "legacy_watch_held",
          detail: binding.displayName,
        },
      };
    }
  }

  // MEMORY 门（spec §3：先完成记忆校验再启动 bridge，顺序不能反）。
  if (deps.memory) {
    const gate = await deps.memory.verifyMemoryAvailable({
      homeWorkspacePath: binding.homeWorkspacePath,
    });
    deps.activity?.setMemoryLoaded(bindingId, gate.ok);
    if (!gate.ok) {
      deps.activity?.record(bindingId, "error");
      deps.logger?.warn(undefined, "raft watch start blocked: memory unavailable", {
        bindingId,
        gateCode: gate.code,
        detail: gate.detail,
      });
      return {
        ok: false,
        failure: {
          code: "MemoryUnavailable",
          reason: "memory_unavailable",
          detail: gate.detail ? `${gate.code}: ${gate.detail}` : gate.code,
        },
      };
    }
  }

  // 官方 MCP 引用（fail-closed）：没有 Raft 工具的会话收了唤醒也无法处理，
  // fail-fast 比带病值守好。
  const officialMcpServers = await deps.resolveOfficialMcpServers(binding);
  if (officialMcpServers === undefined || officialMcpServers.length === 0) {
    deps.activity?.record(bindingId, "error");
    deps.logger?.warn(undefined, "raft watch start blocked: official mcp unavailable", { bindingId });
    return { ok: false, failure: { code: "McpUnavailable", reason: "mcp_unavailable" } };
  }

  return { ok: true, cliPath: resolution.cliPath, binding, officialMcpServers };
}
