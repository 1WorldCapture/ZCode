/**
 * 路径包含判定的唯一事实源（复用审核 #8：此前 raft 侧四处各写一份、判据形态不一）。
 *
 * 两组谓词刻意分开，不可合并：
 * - relativePathEscapesRoot：relative(root, target) 结果的精确判据（".." 段或绝对
 *   路径）——memoryService 原判据原样收敛于此。注意它接受 "..foo" 这类同级名
 *   （首两字符是点但不是父引用）；若换成 ".." 前缀形态会拒掉合法路径，属行为变化。
 * - isResolvedPathWithin：两侧已规范化（resolve/realpath 之后）绝对路径的前缀判据。
 *   供破坏性与读取面守卫用：root 拼上分隔符再比前缀，杜绝 "/root-evil" 被误判在
 *   "/root" 之下的经典前缀 bug；root-equal 是否放行由调用方语义决定（本判据放行，
 *   调用方需要"严格在根下"时自行先排除相等）。
 */
import { isAbsolute, sep } from "node:path";

/** relative(root, target) 的结果是否越出 root：`..` 段或绝对路径（精确形态）。 */
export function relativePathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

/**
 * 已规范化绝对路径 target 是否等于 root 或落在 root 之下（前缀形态，保守）。
 * 调用方负责先 resolve/realpath 两侧；root 末尾多余的分隔符会被归一处理。
 */
export function isResolvedPathWithin(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}
