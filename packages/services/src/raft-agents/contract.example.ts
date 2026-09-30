/**
 * contract 使用示例：宿主组合（node.ts 的 createLocalServices）与服务消费方式。
 * 仅作参考，不参与运行时。
 */
import type { IRaftAgentsService } from "./contract.js";

export async function useRaftAgents(service: IRaftAgentsService): Promise<void> {
  // 单表单接入：token 只进输入参数，直达官方 CLI 的 stdin。
  const result = await service.createBinding({
    raftOrigin: "https://raft.example.com",
    raftAgentId: "11111111-2222-3333-4444-555555555555",
    token: "sk_agent_…", // pragma: allowlist-secret —— 示例占位
    homeWorkspacePath: "/home/.zcode/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/workspace",
  });
  if (result.ok) {
    // 保存即 ReadyStopped：未启动 bridge、未读收件箱、未发言。
    await service.setDesiredState(result.binding.bindingId, "Running");
  }

  // 列表投影（运行状态派生）。
  for (const item of await service.list()) {
    if (typeof item.runState === "object") {
      // ErrorPaused 携带原因，UI 必须与用户暂停区分展示。
    }
  }

  // 变更广播。
  service.onBindingsChanged(() => {
    // 重新拉 list()。
  });
}
