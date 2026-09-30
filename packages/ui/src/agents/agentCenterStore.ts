/**
 * Agent 中心 UI store —— 第一期 mock 阶段。
 *
 * 数据目前来自内存 mock（覆盖生命周期全部状态，便于联调展示）；
 * task #2 的 Binding registry 服务落地后，列表读写改走 RaftIntegrationService 投影，
 * 本 store 只保留视图状态（当前页、选中项、表单草稿）。
 */
import { create } from "zustand";
import { createUuid } from "@zcode/shared";
import type { RaftAgentBinding, RaftAgentBindingInput, RaftAgentListItem } from "@zcode/shared";

export type AgentCenterView =
  | { page: "list" }
  | { page: "connect" }
  | { page: "detail"; bindingId: string };

interface AgentCenterState {
  /** 列表行投影（mock 数据源）。 */
  items: RaftAgentListItem[];
  /** 持久化绑定的 mock 副本（表单提交时追加）。 */
  bindings: RaftAgentBinding[];
  /** 当前视图。 */
  view: AgentCenterView;
  openConnectForm: () => void;
  openDetail: (bindingId: string) => void;
  backToList: () => void;
  /** mock：开始值守（ErrorPaused/ReadyStopped → Starting → Running）。 */
  startAgent: (bindingId: string) => void;
  /** mock：暂停值守（任意状态 → ReadyStopped）。 */
  pauseAgent: (bindingId: string) => void;
  /** mock：表单提交，创建绑定并回到列表。 */
  addBinding: (input: RaftAgentBindingInput) => void;
}

/** 覆盖 spec §3 全部状态的 mock 行，联调后可删除。 */
function createMockItems(): RaftAgentListItem[] {
  return [
    {
      bindingId: "mock-binding-reviewer",
      displayName: "Reviewer",
      raftOrigin: "https://raft.build",
      connectionState: "credential_ok",
      runState: "Running",
      homePath: "/Users/demo/.zcode/agents/mock-binding-reviewer/workspace",
    },
    {
      bindingId: "mock-binding-docs-helper",
      displayName: "Docs Helper",
      raftOrigin: "https://raft.build",
      connectionState: "credential_ok",
      runState: "ReadyStopped",
      homePath: "/Users/demo/.zcode/agents/mock-binding-docs-helper/workspace",
    },
    {
      bindingId: "mock-binding-test-bot",
      displayName: "Test Bot",
      raftOrigin: "https://raft-dev.internal.example",
      connectionState: "unverified",
      runState: { kind: "ErrorPaused", reason: "memory_unavailable" },
      homePath: "/Users/demo/.zcode/agents/mock-binding-test-bot/workspace",
    },
    {
      bindingId: "mock-binding-legacy",
      displayName: "Legacy Bot",
      raftOrigin: "https://raft-dev.internal.example",
      connectionState: "credential_invalid",
      runState: { kind: "ErrorPaused", reason: "credential_invalid" },
      homePath: "/Users/demo/.zcode/agents/mock-binding-legacy/workspace",
    },
  ];
}

/** mock：模拟启动中的短暂过渡，之后落到 Running。 */
function scheduleRunning(bindingId: string) {
  setTimeout(() => {
    useAgentCenterStore.setState((state) => ({
      items: state.items.map((item) =>
        item.bindingId === bindingId && item.runState === "Starting"
          ? { ...item, runState: "Running" as const }
          : item,
      ),
    }));
  }, 600);
}

export const useAgentCenterStore = create<AgentCenterState>()((set) => ({
  items: createMockItems(),
  bindings: [],
  view: { page: "list" },

  openConnectForm: () => set({ view: { page: "connect" } }),
  openDetail: (bindingId) => set({ view: { page: "detail", bindingId } }),
  backToList: () => set({ view: { page: "list" } }),

  startAgent: (bindingId) => {
    set((state) => ({
      items: state.items.map((item) =>
        item.bindingId === bindingId ? { ...item, runState: "Starting" as const } : item,
      ),
    }));
    scheduleRunning(bindingId);
  },

  pauseAgent: (bindingId) => {
    set((state) => ({
      items: state.items.map((item) =>
        item.bindingId === bindingId ? { ...item, runState: "ReadyStopped" as const } : item,
      ),
    }));
  },

  addBinding: (input) => {
    const bindingId = createUuid();
    const now = new Date().toISOString();
    const raftOrigin = input.raftOrigin.trim().replace(/\/+$/, "");
    const binding: RaftAgentBinding = {
      bindingId,
      displayName: input.raftAgentId.trim(),
      raftOrigin,
      serverId: "",
      raftAgentId: input.raftAgentId.trim(),
      profileSlug: `raft-${bindingId.slice(0, 8)}`,
      homeWorkspacePath: input.homeWorkspacePath?.trim() ?? "",
      mainSessionRef: null,
      desiredState: "ReadyStopped",
      autostartConsent: false,
      adapterInstance: bindingId,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      bindings: [...state.bindings, binding],
      items: [
        ...state.items,
        {
          bindingId,
          displayName: binding.displayName,
          raftOrigin,
          // mock 阶段新绑定未经官方 login 核验，保持 unverified。
          connectionState: "unverified",
          runState: "ReadyStopped",
          homePath: binding.homeWorkspacePath,
        },
      ],
      view: { page: "list" },
    }));
  },
}));
