/**
 * Agent Home（T5）的 app 层端口。与 ports.ts / bridgePorts.ts 分开，避免任务间改同一个文件。
 */

export interface AgentHomeInitInput {
  bindingId: string;
  displayName: string;
  /** Raft 公开档案的角色描述；缺省渲染为「尚未定义职责」。 */
  description?: string;
  homeWorkspacePath: string;
}

/** 值守开始前的记忆可用性结果；失败码可区分，供 UI 显示原因。 */
export type MemoryVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code: "HomeMissing" | "MemoryMissing" | "MemoryUnreadable" | "MemoryEmpty";
      detail?: string;
    };

export interface AgentHomePort {
  /**
   * 创建 Home（MEMORY.md / AGENTS.md / notes/），缺失才写、永不覆盖；幂等。
   * 应放进 provisioning，且排在建主会话之前（会话的 workspace = Agent Home）。
   */
  initialize(input: AgentHomeInitInput): Promise<void>;
  /**
   * 值守开始前的同步闸门：只读检查，不创建任何东西（spec §5：MEMORY 应存在却读不到时
   * 不得当作全新 agent 继续，也不得复用项目记忆那种宽松 catch）。
   */
  verifyMemoryAvailable(input: { homeWorkspacePath: string }): Promise<MemoryVerifyResult>;
}
