/**
 * Raft Agent 记忆（Agent Home）的严格加载语义。
 *
 * 与项目记忆刻意不同：项目记忆把「缺失/不可读」当作没有该 context source（宽松 catch），
 * Agent 的 MEMORY.md 是身份恢复入口，应存在却读不到时必须让会话失败，
 * 由宿主置为异常暂停，而不是让 Agent 以「全新」状态继续工作。
 */
export type AgentMemoryUnavailableCode =
  | "home_missing"
  | "memory_missing"
  | "memory_unreadable"
  | "memory_empty";

export class AgentMemoryUnavailableError extends Error {
  readonly code: AgentMemoryUnavailableCode;

  constructor(code: AgentMemoryUnavailableCode, detail?: string) {
    super(`agent_memory_unavailable:${code}${detail ? `:${detail}` : ""}`);
    this.name = "AgentMemoryUnavailableError";
    this.code = code;
  }
}

/** 名称来自 Raft 公开档案（不可信）：压成单行并截断，避免借换行伪造提示词结构。 */
export function sanitizeAgentName(name: string | undefined): string {
  // 按码点判断控制字符，避免在正则字面量里写入不可见字符。
  let out = "";
  for (const ch of name ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0x1f || code === 0x7f ? " " : ch;
  }
  const collapsed = out.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "Raft Agent";
  return collapsed.length > 120 ? `${collapsed.slice(0, 120).trimEnd()}…` : collapsed;
}
