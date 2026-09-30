/**
 * Agent Home provisioning 步骤（T5，spec §4 步骤 4）：初始化 Home 文件。
 * 幂等（缺失才写）；必须排在主会话步骤之前（会话的 workspace = Agent Home）。
 */
import type { RaftProvisioningStep } from "../contract.js";
import type { AgentHomePort } from "./agentHomePorts.js";

export function createAgentHomeProvisioningStep(home: AgentHomePort): RaftProvisioningStep {
  return {
    name: "agent-home",
    async execute(binding) {
      await home.initialize({
        bindingId: binding.bindingId,
        displayName: binding.displayName,
        homeWorkspacePath: binding.homeWorkspacePath,
      });
    },
  };
}
