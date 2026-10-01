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

/**
 * 重启值守（B1）：停值守 → 新建主会话（记忆保留）→ 恢复。进行中 turn 被放弃。
 * 失败只置 actionFailed，状态以服务返回为准（成功后由刷新投影）。
 */
export async function restartAgent(
  service: IRaftAgentsService,
  bindingId: string,
): Promise<boolean> {
  const store = useAgentCenterStore.getState();
  store.setActionFailed(false);
  try {
    const result = await service.restartBinding(bindingId);
    if (!result.ok) {
      store.setActionFailed(true);
      return false;
    }
  } catch (error) {
    logger.warn("[AgentCenter] 重启 Agent 失败", { bindingId, error });
    store.setActionFailed(true);
    return false;
  }
  await refreshAgents(service);
  return true;
}

/**
 * 重置（B1）：同重启，但先清空 Home 记忆面并按初始模板重建（其他内容不动）。
 */
export async function resetAgent(
  service: IRaftAgentsService,
  bindingId: string,
): Promise<boolean> {
  const store = useAgentCenterStore.getState();
  store.setActionFailed(false);
  try {
    const result = await service.resetBinding(bindingId);
    if (!result.ok) {
      store.setActionFailed(true);
      return false;
    }
  } catch (error) {
    logger.warn("[AgentCenter] 重置 Agent 失败", { bindingId, error });
    store.setActionFailed(true);
    return false;
  }
  await refreshAgents(service);
  return true;
}

/**
 * 删除（B1）：二次确认后调用；deleteHome 清除 Home 目录（含 projects/）与本地 profile，
 * 不撤销 Raft 侧 token（确认文案已提示用户）。
 *
 * 返回 Home 处置四态（e3479b5 定稿，见 SPEC「二期 A1」）：deleted / kept_memory_cleared /
 * untouched(not_requested|refused) / failed。界面必须按态如实提示，failed 可能已部分删除。
 */
export type AgentHomeOutcome = Awaited<ReturnType<IRaftAgentsService["removeBinding"]>>;

export async function removeAgent(
  service: IRaftAgentsService,
  bindingId: string,
): Promise<{ ok: true; home: AgentHomeOutcome } | { ok: false }> {
  const store = useAgentCenterStore.getState();
  store.setActionFailed(false);
  try {
    const home = await service.removeBinding(bindingId, { deleteHome: true });
    await refreshAgents(service);
    return { ok: true, home };
  } catch (error) {
    logger.warn("[AgentCenter] 删除 Agent 失败", { bindingId, error });
    store.setActionFailed(true);
    return { ok: false };
  }
}

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
