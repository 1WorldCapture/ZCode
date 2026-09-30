/**
 * Agent 中心的服务调用（薄封装）：所有写操作都走 host 服务，成功后立刻刷新快照。
 * 失败只记录到 store 的提示位，不做乐观更新——状态以服务返回为准。
 */
import type { IRaftAgentsService } from "@zcode/services";
import { logger } from "../logger.js";
import { useAgentCenterStore } from "./agentCenterStore.js";
import type { RaftAgentBindingInput } from "@/agents/types.js";

export async function refreshAgents(service: IRaftAgentsService): Promise<void> {
  const store = useAgentCenterStore.getState();
  try {
    store.setItems(await service.list());
  } catch (error) {
    logger.warn("[AgentCenter] 加载 Agent 列表失败", { error });
    store.setLoadFailed(true);
  }
}

async function setDesired(
  service: IRaftAgentsService,
  bindingId: string,
  desired: "ReadyStopped" | "Running",
): Promise<void> {
  const store = useAgentCenterStore.getState();
  store.setActionFailed(false);
  try {
    await service.setDesiredState(bindingId, desired);
  } catch (error) {
    logger.warn("[AgentCenter] 更新值守状态失败", { bindingId, desired, error });
    store.setActionFailed(true);
  }
  await refreshAgents(service);
}

export const startAgent = (service: IRaftAgentsService, bindingId: string) =>
  setDesired(service, bindingId, "Running");

export const pauseAgent = (service: IRaftAgentsService, bindingId: string) =>
  setDesired(service, bindingId, "ReadyStopped");

/** 提交接入表单；成功返回 true 并回到列表。token 只在这次调用里存在，不进 store。 */
export async function submitConnect(
  service: IRaftAgentsService,
  input: RaftAgentBindingInput,
): Promise<boolean> {
  const store = useAgentCenterStore.getState();
  if (store.submitting) return false;
  store.setSubmitting(true);
  store.setSubmitError(null);
  try {
    const result = await service.createBinding(input);
    if (!result.ok) {
      store.setSubmitError({ code: result.code, detail: result.detail });
      return false;
    }
    await refreshAgents(service);
    store.backToList();
    return true;
  } catch (error) {
    // RPC 层异常：用最接近的通用码提示，细节只进日志（不含 token）。
    logger.warn("[AgentCenter] 接入请求失败", { error });
    store.setSubmitError({ code: "StoreWriteFailed" });
    return false;
  } finally {
    store.setSubmitting(false);
  }
}
