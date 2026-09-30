/**
 * 官方宿主 MCP 具名引用构造（纯函数，方案 1 / 线程 f3239b45）。
 *
 * 宿主只给 name + env；command/args/isolation/protocolVersion 由 app-server 用
 * 自己的插件 rootPath 拼装并锁定。env 只放路径与标识（SPEC.md T3 小节约定），
 * **不放 token**——token 只存在于官方 profile 体系与 bridge 子进程环境。
 * 键必须以 ZCODE_RAFT_ 开头（app-server 侧白名单拒绝其余键）。
 */
import { join } from "node:path";

import type { RaftAgentBinding, ZCodeOfficialMcpServerRef } from "@zcode/shared";

export interface RaftOfficialMcpEnvInput {
  /** 应用数据根（与绑定服务同一根：profile 与 Home 路径都从它派生）。 */
  dataRootDir: string;
  /** T1 已校验的 CLI 入口（dist/index.js 语义）。 */
  cliPath: string;
  /** 收件日志保留天数（spec §7：默认 14 天，上限可配）。 */
  inboxRetentionDays?: number;
}

/** 绑定的 profile 目录（T1 布局：<dataRoot>/raft/profiles/<slug>）。 */
export function raftProfileDir(dataRootDir: string, profileSlug: string): string {
  return join(dataRootDir, "raft", "profiles", profileSlug);
}

/** 构造 raft-agent-tools 的具名引用（env 按 binding 派生，per-binding 身份标识）。 */
export function buildRaftAgentToolsMcpRef(
  binding: RaftAgentBinding,
  input: RaftOfficialMcpEnvInput,
): ZCodeOfficialMcpServerRef {
  const env: Array<{ name: string; value: string }> = [
    { name: "ZCODE_RAFT_BINDING_ID", value: binding.bindingId },
    { name: "ZCODE_RAFT_PROFILE_SLUG", value: binding.profileSlug },
    { name: "ZCODE_RAFT_PROFILE_DIR", value: raftProfileDir(input.dataRootDir, binding.profileSlug) },
    { name: "ZCODE_RAFT_DATA_ROOT", value: input.dataRootDir },
    { name: "ZCODE_RAFT_CLI_PATH", value: input.cliPath },
  ];
  if (input.inboxRetentionDays !== undefined) {
    env.push({ name: "ZCODE_RAFT_INBOX_RETENTION_DAYS", value: String(input.inboxRetentionDays) });
  }
  return { name: "raft-agent-tools", env };
}
