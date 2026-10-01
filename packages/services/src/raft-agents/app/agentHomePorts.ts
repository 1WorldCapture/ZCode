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

  // ── 二期 A1：记忆面只读视图 / 重置 / Home 删除 ──

  /** 记忆面文件列表（MEMORY.md、AGENTS.md、notes/** 递归；跳过符号链接）。 */
  listMemoryFiles(input: {
    homeWorkspacePath: string;
  }): Promise<{ ok: true; files: Array<{ path: string; size: number; modifiedAt: string }> } | { ok: false; code: "HomeMissing" }>;
  /** 读记忆面单个文件；realpath 两侧包含判定，越出记忆面在执行边界拒绝。 */
  readMemoryFile(input: {
    homeWorkspacePath: string;
    path: string;
    maxBytes?: number;
  }): Promise<
    | { ok: true; content: string; modifiedAt: string; truncated: boolean }
    | { ok: false; code: "NotFound" | "OutsideMemorySurface" | "Unreadable"; detail?: string }
  >;
  /**
   * 清记忆面三处（MEMORY.md、AGENTS.md、notes/ 整树）——重置动作的前半段；
   * 清完再跑 initialize() 即恢复初始模板。不动 Home 其他内容。
   */
  resetMemorySurface(input: { homeWorkspacePath: string }): Promise<{ ok: true } | { ok: false; code: "HomeMissing" | "ResetFailed"; detail?: string }>;
  /**
   * 删除整个 Home 目录（删除动作，destructive）。守卫：realpath 后必须是目录、
   * 非文件系统根/用户主目录、且（含 Home 标记文件 或 位于数据根 agents/ 下）——
   * 防误删任意用户目录。目录不存在视为成功（幂等）。
   */
  deleteHome(input: { homeWorkspacePath: string; dataRootDir: string }): Promise<{ ok: true } | { ok: false; code: "Refused" | "Failed"; detail?: string }>;
}
