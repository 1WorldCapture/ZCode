/**
 * Agent Home 归属分类（PM 修法四条，2026-10-02）：default / custom / unknown-home。
 *
 * 背景：向导预派发 Home 的容器名是独立 UUID，**不等于 bindingId**。任何
 * `agents/<bindingId>/workspace` 形态的判定都会把默认 Home 误判成 custom（记忆漏复制）。
 *
 * 判定规则（位置为主判据 + 归属标记一致性校验；导入器与 UI 投影共用本函数，
 * UI 只读投影里的结论字段，绝不自算）：
 * - default：homeWorkspacePath 解析后落在 `<dataRoot>/agents/<容器>/workspace`
 *   （容器 = agents/ 下任意直接子目录名），且 Home 根下 `.zcode-agent-home`
 *   存在、内容 === bindingId；
 * - custom：解析后不在 `<dataRoot>/agents/` 下（用户自选目录，两产品共用；
 *   导入不复制、删除绑定时不得删除目录）；
 * - unknown-home：位置是默认形态但标记缺失/读不出/内容不符——归属不明，
 *   导入器拒绝导入该绑定（宁可少导，不可把别的绑定的 Home 错配过来）。
 */
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 归属标记文件名（内容 = bindingId；agentHome.claimHomeOwnership 独占创建）。 */
export const AGENT_HOME_OWNERSHIP_MARKER = ".zcode-agent-home";

export type AgentHomeKindResolution =
  | { kind: "default"; containerDirName: string; homeRealPath: string }
  | { kind: "custom" }
  | {
      kind: "unknown-home";
      reason: "invalid-home-path" | "marker-missing" | "marker-unreadable" | "marker-mismatch";
      detail: string;
    };

/**
 * 规范化路径（两侧同款，避免 /var → /private/var 根别名错位）：目标存在用 realpath；
 * 不存在则逐级上溯到最近存在的祖先，realpath 后把后缀拼回（Home 深层目录整个不存在、
 * 甚至 agents/<容器>/ 已被用户删除的边界也要能与数据根对上前缀）；祖先链全不存在退
 * resolve。不跟随目标自身的符号链接（字面布局即归属语义；复制方拿到的路径在目标
 * 存在时与 realpath 等价）。
 */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    /* 目标不存在：从最近存在的祖先拼回后缀 */
  }
  let parent = dirname(resolved);
  const suffix: string[] = [basename(resolved)];
  for (;;) {
    try {
      return join(await realpath(parent), ...suffix);
    } catch {
      const next = dirname(parent);
      if (next === parent) return resolved;
      suffix.unshift(basename(parent));
      parent = next;
    }
  }
}

/**
 * 只读分类，绝不创建/写入任何文件。返回 default 时附带容器名与解析后的
 * Home 实路径（复制方应使用实路径，避免符号链接根把复制引到别处）。
 */
export async function resolveAgentHomeKind(input: {
  dataRootDir: string;
  bindingId: string;
  homeWorkspacePath: string;
}): Promise<AgentHomeKindResolution> {
  const homePath = input.homeWorkspacePath?.trim() ?? "";
  if (!homePath || !isAbsolute(homePath)) {
    return { kind: "unknown-home", reason: "invalid-home-path", detail: "home path empty or relative" };
  }
  const homeResolved = await canonicalPath(homePath);
  const agentsRoot = join(await canonicalPath(input.dataRootDir), "agents");
  if (!homeResolved.startsWith(`${agentsRoot}${sep}`)) return { kind: "custom" };
  const segments = relative(agentsRoot, homeResolved).split(sep);
  // 默认形态严格限定 `<agents>/<容器>/workspace`（单层容器）；更深/更浅层级视为用户自选。
  if (segments.length !== 2 || segments[1] !== "workspace") return { kind: "custom" };
  const containerDirName = segments[0]!;
  let marker: string;
  try {
    marker = await readFile(join(homeResolved, AGENT_HOME_OWNERSHIP_MARKER), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "unknown-home",
      reason: code === "ENOENT" ? "marker-missing" : "marker-unreadable",
      detail: `ownership marker unreadable (${code ?? "unknown"})`,
    };
  }
  if (marker.trim() !== input.bindingId) {
    return {
      kind: "unknown-home",
      reason: "marker-mismatch",
      detail: "ownership marker does not match bindingId",
    };
  }
  return { kind: "default", containerDirName, homeRealPath: homeResolved };
}
