/**
 * 主会话 provisioning 步骤（T3，spec §4 步骤 5 / §6）。
 *
 * 职责：绑定创建期建立空主会话并一次性注入 Raft 工具 MCP 配置。
 * - 通道选择：session/create RPC（zcodeAgentService.createSession）而非 V4 createSession
 *   命令——后者拒绝空 firstInput，而 spec §4 要求创建期不发任何消息；两条通道的
 *   mcpServers wire 形状一致（env {name,value}[]），一次性注入语义同在启动期生效。
 * - 幂等：mainSessionRef 已存在即跳过（重试不重建会话）。
 * - fail-closed：MCP 配置解析不到（插件未 stage/rootPath 缺失）直接失败——没有
 *   Raft 工具的会话对值守无意义，宁可不建（ProvisioningFailed 可重试）。
 * - 写回：步骤变异 binding.mainSessionRef（{sessionId, sessionGeneration: 1}），
 *   由 raftAgentsService 在步骤全部成功后统一持久化（步骤不自行写 store）。
 * - 顺序要求：须排在 T5 Home 初始化步骤之后（会话的 workspace = Agent Home）。
 */
import type { ZCodeAgentMcpServer } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftProvisioningStep } from "../contract.js";
import type { RaftSessionPort } from "./ports.js";

export interface MainSessionProvisioningOptions {
  sessions: RaftSessionPort;
  /**
   * 解析 Raft 工具的 MCP wire 配置（宿主注入：插件 rootPath 发现 + ELECTRON_RUN_AS_NODE
   * + 插件宿主前缀参数都在 app 层拼装，services 不依赖 bootstrap/Electron 形态）。
   * 返回 undefined = 插件不可用（fail-closed）。
   */
  resolveMcpServers: () => Promise<ZCodeAgentMcpServer[] | undefined>;
  logger?: ServiceLogger;
}

export function createMainSessionProvisioningStep(
  options: MainSessionProvisioningOptions,
): RaftProvisioningStep {
  return {
    name: "main-session",
    async execute(binding) {
      if (binding.mainSessionRef !== null) {
        // 幂等：会话已建立（重试/并发重建由绑定唯一性兜底）。
        return;
      }
      const mcpServers = await options.resolveMcpServers();
      if (mcpServers === undefined || mcpServers.length === 0) {
        throw new Error("raft tools MCP config unavailable (plugin not staged?)");
      }
      const created = await options.sessions.createAgentSession({
        workspacePath: binding.homeWorkspacePath,
        mcpServers,
      });
      if (!created.ok) {
        throw new Error(`createAgentSession failed: ${created.detail ?? "unknown"}`);
      }
      binding.mainSessionRef = {
        sessionId: created.sessionId,
        // 初始代次 1；恢复/重置时 +1（fencing，spec §6）。
        sessionGeneration: 1,
      };
      options.logger?.info(undefined, "raft main session created", {
        bindingId: binding.bindingId,
        sessionId: created.sessionId,
      });
    },
  };
}
