/**
 * Agent 中心 UI store —— 只保存视图状态与服务端事实的本地投影。
 *
 * 权威数据在 host 的 RaftAgentsService（绑定记录 + 运行态覆盖层）；这里的 items 只是
 * 最近一次 list() 的快照，由 useAgentCenterSync 经事件与轮询刷新，UI 不推导、不持久化。
 * token 永不进入本 store（只存在于表单组件的本次提交内）。
 */
import { create } from "zustand";
import type { RaftAgentListItem, RaftAgentSetupErrorCode } from "@/agents/types.js";

export type AgentCenterView =
  | { page: "list" }
  | { page: "connect" }
  | { page: "detail"; bindingId: string };

export interface AgentSubmitError {
  code: RaftAgentSetupErrorCode;
  /** 已完成到的步骤/冲突对象等补充信息（展示用，不含凭据）。 */
  detail?: string;
}

interface AgentCenterState {
  /** 最近一次 list() 的快照。 */
  items: RaftAgentListItem[];
  /** 是否已成功加载过一次（区分「空列表」与「还没加载」）。 */
  loaded: boolean;
  /** 最近一次刷新失败（服务不可用/RPC 异常）；成功后清除。 */
  loadFailed: boolean;
  /**
   * 绑定记录文件损坏（getStorageHealth 有形状结果；fail-closed：原文件保留等待手动恢复）。
   * backupPath 为 null 表示备份创建失败，提示须如实说明。与 loadFailed 互斥显示。
   */
  corruptStorage: { backupPath: string | null } | null;
  view: AgentCenterView;
  /** 接入表单提交中（provisioning 可能要几秒）。 */
  submitting: boolean;
  submitError: AgentSubmitError | null;
  /** 开始/暂停等操作的失败提示。 */
  actionFailed: boolean;
  openConnectForm: () => void;
  openDetail: (bindingId: string) => void;
  backToList: () => void;
  setItems: (items: RaftAgentListItem[]) => void;
  setLoadFailed: (failed: boolean) => void;
  setCorruptStorage: (corrupt: { backupPath: string | null } | null) => void;
  setSubmitting: (submitting: boolean) => void;
  setSubmitError: (error: AgentSubmitError | null) => void;
  setActionFailed: (failed: boolean) => void;
}

export const useAgentCenterStore = create<AgentCenterState>()((set) => ({
  items: [],
  loaded: false,
  loadFailed: false,
  corruptStorage: null,
  view: { page: "list" },
  submitting: false,
  submitError: null,
  actionFailed: false,

  openConnectForm: () => set({ view: { page: "connect" }, submitError: null }),
  openDetail: (bindingId) => set({ view: { page: "detail", bindingId }, actionFailed: false }),
  backToList: () => set({ view: { page: "list" }, actionFailed: false }),
  setItems: (items) => set({ items, loaded: true, loadFailed: false, corruptStorage: null }),
  setLoadFailed: (loadFailed) => set({ loadFailed }),
  setCorruptStorage: (corruptStorage) => set({ corruptStorage }),
  setSubmitting: (submitting) => set({ submitting }),
  setSubmitError: (submitError) => set({ submitError }),
  setActionFailed: (actionFailed) => set({ actionFailed }),
}));
