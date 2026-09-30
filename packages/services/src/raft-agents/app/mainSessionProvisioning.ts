/**
 * 主会话 provisioning 步骤（T3，spec §4 步骤 5 / §6）。
 *
 * 职责：绑定创建期建立空主会话并一次性注入 Raft 工具与记忆作用域。
 * - 通道选择：session/create RPC（zcodeAgentService.createSession）而非 V4 createSession
 *   命令——后者拒绝空 firstInput，而 spec §4 要求创建期不发任何消息；启动期一次性
 *   注入（agentMemory + officialMcpServers）两条通道语义同在。
 * - 官方宿主 MCP（方案 1，线程 f3239b45）：宿主只给具名引用（name + ZCODE_RAFT_* env），
 *   command/args/隔离/协议版本由 app-server 用自己的插件 rootPath 拼装并锁定——
 *   打包态 execPath 与宿主前缀参数只在 app-server 进程里有意义，宿主侧拼会开发态能跑
 *   生产态断。env 不放 token（token 只在官方 profile 体系）。
 * - 幂等：mainSessionRef 已存在即跳过（重试不重建会话）。
 * - fail-closed：官方 MCP 引用解析不到（插件未 stage）直接失败——没有 Raft 工具的
 *   会话对值守无意义，宁可不建（ProvisioningFailed 可重试）。
 * - 写回：步骤变异 binding.mainSessionRef（{sessionId, sessionGeneration: 1}），
 *   由 raftAgentsService 在步骤全部成功后统一持久化（步骤不自行写 store）。
 * - 顺序要求：须排在 T5 Home 初始化步骤之后（会话的 workspace 与记忆根 = Agent Home）。
 */
import type { ZCodeOfficialMcpServerRef } from "@zcode/shared";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftProvisioningStep } from "../contract.js";
import type { RaftSessionPort } from "./ports.js";

export interface MainSessionProvisioningOptions {
  sessions: RaftSessionPort;
  /**
   * 解析官方宿主 MCP 具名引用（宿主注入：name 固定 "raft-agent-tools"，env 为
   * ZCODE_RAFT_* 常量组，不含 token）。返回 undefined/空 = 插件不可用（fail-closed）。
   */
  resolveOfficialMcpServers: () => Promise<ZCodeOfficialMcpServerRef[] | undefined>;
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
      const officialMcpServers = await options.resolveOfficialMcpServers();
      if (officialMcpServers === undefined || officialMcpServers.length === 0) {
        throw new Error("raft tools MCP config unavailable (plugin not staged?)");
      }
      // 记忆作用域 = Agent Home（T5 已初始化）；agentName 用绑定显示名（模板侧已做单行化）。
      const created = await options.sessions.createAgentSession({
        workspacePath: binding.homeWorkspacePath,
        agentMemory: { homeRoot: binding.homeWorkspacePath, agentName: binding.displayName },
        officialMcpServers,
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
