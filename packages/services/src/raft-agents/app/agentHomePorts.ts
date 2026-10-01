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
   * 绑定时归属声明（评审定稿，线程 cb4426cd）：目录不存在或为空 → 由 ZCode 创建并
   * 独占写入归属标记 `.zcode-agent-home`（内容 bindingId）；已有内容的目录 = 用户
   * 自选，不写标记（删除时只清记忆面、保留目录）。必须先于 initialize 调用——
   * 模板文件会让目录变为"非空"。重置路径不调用（防给用户目录补标记）。
   */
  claimHomeOwnership(input: { homeWorkspacePath: string; bindingId: string }): Promise<void>;
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
   * 删除动作的 Home 收尾（destructive）。守卫（评审定稿）：传入路径本身是符号链接
   * 即拒绝；拒绝文件系统根、用户主目录与数据根目录及其上级；整删仅当归属成立——
   * 归属标记内容与 bindingId 一致，或 Home 恰为默认位置（数据根下
   * agents/&lt;bindingId&gt;/workspace，路径由 bindingId 派生，兼容加标记前的旧绑定）。
   * 归属不成立（用户自选目录 / 旧绑定无标记 / 标记不匹配）：只清记忆三处与标记，
   * 保留目录并以 homeDeleted=false 告知界面。目录不存在视为成功（幂等，homeDeleted=false）。
   */
  deleteHome(input: {
    homeWorkspacePath: string;
    dataRootDir: string;
    bindingId: string;
  }): Promise<{ ok: true; homeDeleted: boolean } | { ok: false; code: "Refused" | "Failed"; detail?: string }>;
}
