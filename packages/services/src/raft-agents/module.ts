/**
 * raft-agents 模块清单：Raft Agent 绑定管理（T1：记录 + 凭据适配 + 单表单接入）。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const raftAgentsModule = {
  id: "raft-agents",
  requires: ["shared", "rpc", "services"],
  provides: ["raft-agents-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
