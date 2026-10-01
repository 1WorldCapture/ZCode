// 实现已抽到 @zcode/shared/node/stdio-process-lifecycle（与 raft-agent-tools 共用）；
// 这里保留原名导出，node-repl-host 调用方与测试不变。
import {
  installStdioProcessGuards,
  installStdioShutdownTriggers,
  isDirectMcpEntrypoint,
} from "@zcode/shared/node/stdio-process-lifecycle";

export { isDirectMcpEntrypoint };

export function installNodeReplProcessGuards(
  input: Omit<Parameters<typeof installStdioProcessGuards>[0], "label">,
): void {
  installStdioProcessGuards({ ...input, label: "node_repl" });
}

export const installNodeReplShutdownTriggers = installStdioShutdownTriggers;
