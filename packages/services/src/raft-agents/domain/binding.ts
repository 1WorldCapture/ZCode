/**
 * 绑定记录的纯校验域（无 IO、无 await）。
 *
 * 规则来自第一期 spec §2「创建时校验」：
 * - raftOrigin 可规范化（http/https、去尾斜杠、小写 host）；
 * - homeWorkspacePath 必须绝对路径，且与任一既有绑定不得相等、不得互为前缀；
 * - profileSlug 唯一，(raftOrigin, serverId, raftAgentId) 组合唯一。
 */
import type { RaftAgentBinding } from "@zcode/shared";

/** 规范化 Raft 服务地址；不可规范化返回 undefined。 */
export function normalizeRaftOrigin(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  url.hash = "";
  url.search = "";
  let origin = url.toString();
  // URL.toString() 对根路径会保留尾斜杠（https://host/），统一去掉；
  // 子路径保留但去尾斜杠（https://host/raft）。
  origin = origin.replace(/\/+$/, "");
  return origin;
}

/**
 * 路径比较形态：去重复分隔符与尾分隔符。仅接受绝对路径。
 * Windows 语义（盘符大小写、反斜杠）由调用方先规范化，这里保持纯词法比较。
 */
export function normalizeHomePathForCompare(
  path: string,
  opts: { win32: boolean },
): string | undefined {
  const normalized = opts.win32 ? path.replace(/\\/g, "/") : path;
  // 绝对路径：POSIX 根斜杠，或 win32 盘符（C:/…）。
  const isAbsolute = normalized.startsWith("/") || (opts.win32 && /^[a-zA-Z]:\//.test(normalized));
  if (!isAbsolute) return undefined;
  const collapsed = normalized.replace(/\/+$/, "");
  return collapsed.length > 0 ? (opts.win32 ? collapsed.toLowerCase() : collapsed) : undefined;
}

/**
 * 双向前缀包含判断（含相等）：a 是 b 的前缀或反之都算冲突（防父目录绕过）。
 * 两个路径都必须已通过 normalizeHomePathForCompare。
 */
export function homePathsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer === shorter || longer.startsWith(`${shorter}/`);
}

/** profileSlug：不依赖显示名，从 bindingId 派生，创建后不变。 */
export function deriveProfileSlug(bindingId: string): string {
  return `raft-${bindingId.replace(/-/g, "").slice(0, 12)}`;
}

/** 与既有绑定的唯一性冲突检测；返回首个冲突项供错误信息使用。 */
export function findBindingConflicts(
  candidate: {
    homePathForCompare: string;
    profileSlug: string;
    raftOrigin: string;
    serverId: string;
    raftAgentId: string;
  },
  existing: RaftAgentBinding[],
  opts: { win32: boolean },
): { kind: "PathConflict" | "SlugConflict" | "AlreadyBound"; conflictWith: RaftAgentBinding } | undefined {
  for (const binding of existing) {
    const bindingPath = normalizeHomePathForCompare(binding.homeWorkspacePath, opts);
    if (bindingPath !== undefined && homePathsConflict(candidate.homePathForCompare, bindingPath)) {
      return { kind: "PathConflict", conflictWith: binding };
    }
    if (binding.profileSlug === candidate.profileSlug) {
      return { kind: "SlugConflict", conflictWith: binding };
    }
    // 同一身份（同源+同服务器+同 agent）重复接入：指向既有绑定，用用户可理解的
    // AlreadyBound 而非内部 slug 术语。
    if (
      binding.raftOrigin === candidate.raftOrigin &&
      binding.serverId === candidate.serverId &&
      binding.raftAgentId === candidate.raftAgentId
    ) {
      return { kind: "AlreadyBound", conflictWith: binding };
    }
  }
  return undefined;
}
