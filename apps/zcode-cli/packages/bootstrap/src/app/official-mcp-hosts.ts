import type { McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import type { ZCodeOfficialMcpServerRef } from "@zcode/shared";
import { OFFICIAL_RAFT_AGENT_TOOLS_PLUGIN_ID } from "./official-plugin-definitions.js";
import { createBundledMcpRuntimeConfig } from "./official-plugin-runtime.js";

/**
 * 官方宿主型 MCP 服务的具名解析：宿主只给名字与环境变量，command/args/隔离/协议版本
 * 全部在 app-server 进程里用自己的插件 rootPath 拼装并锁定。
 *
 * 为什么不让宿主直接给 command：打包态 `process.execPath` 与插件宿主前缀参数
 * 只在 app-server 进程里有意义；宿主侧（Electron main）自己拼，开发态同构能跑、打包态必断。
 *
 * 安全：name 走白名单；env 只接受该服务约定的键前缀，防止调用方借环境变量
 * （如 NODE_OPTIONS）改变被拉起进程的行为；缺插件时 fail-closed 抛错，不静默降级为无工具会话。
 */
interface OfficialMcpHost {
  pluginId: string;
  /** 会话内的 MCP server 名（工具名前缀 mcp__<serverKey>__）。 */
  serverKey: string;
  envKeyPrefix: string;
  timeoutMs: number;
}

const OFFICIAL_MCP_HOSTS: Record<ZCodeOfficialMcpServerRef["name"], OfficialMcpHost> = {
  "raft-agent-tools": {
    pluginId: OFFICIAL_RAFT_AGENT_TOOLS_PLUGIN_ID,
    serverKey: "raft_agent_tools",
    envKeyPrefix: "ZCODE_RAFT_",
    timeoutMs: 120_000,
  },
};

export class OfficialMcpHostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficialMcpHostUnavailableError";
  }
}

export function resolveRequestedOfficialMcpServers(input: {
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">;
  requested: readonly { name: ZCodeOfficialMcpServerRef["name"]; env: Record<string, string> }[] | undefined;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const resolved: Record<string, McpServerConfig> = {};
  for (const ref of input.requested ?? []) {
    const host = Object.hasOwn(OFFICIAL_MCP_HOSTS, ref.name) ? OFFICIAL_MCP_HOSTS[ref.name] : undefined;
    if (!host) throw new OfficialMcpHostUnavailableError(`unknown official MCP host: ${ref.name}`);
    for (const key of Object.keys(ref.env)) {
      if (!key.startsWith(host.envKeyPrefix)) {
        throw new OfficialMcpHostUnavailableError(`env key not allowed for ${ref.name}: ${key}`);
      }
    }
    const plugin = input.pluginOutcome.plugins.find((entry) => entry.id === host.pluginId && entry.enabled);
    if (!plugin) {
      throw new OfficialMcpHostUnavailableError(`official MCP host plugin not available: ${host.pluginId}`);
    }
    const config = createBundledMcpRuntimeConfig({
      cwd: input.workingDirectory,
      env: ref.env,
      rootPath: plugin.rootPath,
      timeoutMs: host.timeoutMs,
    });
    if (!config) throw new OfficialMcpHostUnavailableError(`cannot resolve plugin host command for ${ref.name}`);
    resolved[host.serverKey] = {
      ...config,
      // 隔离与协议版本由 app-server 锁定：Raft 工具带绑定身份，必须按会话隔离，不得跨会话共享连接。
      isolation: "session",
      protocolVersion: "2026-07-28",
    };
  }
  return resolved;
}
