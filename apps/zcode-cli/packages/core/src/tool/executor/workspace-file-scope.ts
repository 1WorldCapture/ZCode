// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

import { dirname, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

import type { PermissionDecisionResult } from "../../permission/service.js";
import { isResolvedPathInsideRoot, resolveWorkspacePath } from "../path-policy.js";

/**
 * 无人值守会话的文件工具边界（wire 参数 confineFileToolsToWorkspace）。
 *
 * 为什么独立于既有机制：yolo 放行在权限服务里排在项目 deny 规则之前；toolAllowlist
 * 只决定"注册了哪些工具"。两者都约束不了一个已注册文件工具指向哪里——而值守会话
 * 的写入根（workspaceRoot = Agent Home）一旦被越出，等价于把宿主机全盘文件交给
 * 一个由频道消息驱动的模型（Home 外不远处就是 Raft profile 的明文凭据）。本检查
 * 在执行边界收口，排在 yolo 放行之后，deny 可恢复。
 *
 * 覆盖面刻意收窄到路径入参可静态提取的工具：Read/Write/Edit/Glob/Grep。ApplyPatch
 * 的路径藏在 patch_text 里，无法低成本做同样的校验，因此无人值守会话的工具白名单
 * 直接不包含它（见 raft-agents 适配器）。Bash 不在值守白名单内，天然不经过这里。
 *
 * 两类越界都拦（评审定稿）：
 * 1. 路径入参（file_path/path/cwd）：字符串解析后对已存在的部分取 realpath 再判
 *    包含——Home 内预置的指向外部的符号链接绕不过字符串比较，这里解析掉。
 *    例外：Glob/Grep 的范围目录等于工作区根本身（含 "." 解析结果）不算越界——
 *    搜索工具的合法语义（审核报告 D2）；文件类工具照旧拒绝根本身。
 * 2. 模式入参（Glob.pattern / Grep.glob）：glob 模式里的 `..` 段与绝对路径前缀
 *    直接拒绝（保守 fail-closed；值守会话换个等价写法没有损失）。
 */

const FILE_SCOPE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);

/** 这些键在五个工具的输入 schema 里都是路径/cwd；其余键不参与路径解析。 */
const FILE_SCOPE_PATH_KEYS: readonly string[] = ["file_path", "path", "cwd"];

/** glob 类路径模式键：按工具区分（Grep.pattern 是内容正则，刻意不在列）。 */
const FILE_SCOPE_PATTERN_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Glob", ["pattern"]],
  ["Grep", ["glob"]],
]);

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

export async function applyWorkspaceFileScopePermission(input: {
  decision: PermissionDecisionResult;
  enabled: boolean | undefined;
  executionInput: unknown;
  toolName: string;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<PermissionDecisionResult> {
  if (!input.enabled || !FILE_SCOPE_TOOLS.has(input.toolName)) return input.decision;

  if (!input.executionInput || typeof input.executionInput !== "object") return input.decision;
  const record = input.executionInput as Record<string, unknown>;

  if (patternKeyEscapesRoot(input.toolName, record)) {
    return denyScopeDecision(input.decision, input.workspaceRoot);
  }

  const operation = WRITE_TOOLS.has(input.toolName) ? "write" : "read";
  // Glob/Grep 的 path/cwd 是"搜索范围目录"语义：模型常显式传工作区根本身（或 "."），
  // 等于根不算越界（审核报告 D2）；Read/Write/Edit 的目标是文件，根本身照旧拒绝。
  const allowRootAsScope = input.toolName === "Glob" || input.toolName === "Grep";
  const realRoot = await realPathLongestExisting(input.workspaceRoot);
  for (const key of FILE_SCOPE_PATH_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const resolvedPath = resolveWorkspacePath({
      inputPath: value,
      operation,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
    // 判定统一在 realpath 两侧进行：根与目标都规范化后再比包含。符号链接逃逸
    // （Home 内链接指向外部）在目标侧现形；根本身经符号链接给出（macOS /var →
    // /private/var 一类）在根侧消解，同目录的两种写法不会被误判。
    const realTarget = await realPathLongestExisting(resolvedPath);
    if (isResolvedPathInsideRoot(realTarget, realRoot)) continue;
    if (allowRootAsScope && realTarget === realRoot) continue;
    return denyScopeDecision(input.decision, input.workspaceRoot);
  }
  return input.decision;
}

function denyScopeDecision(
  decision: PermissionDecisionResult,
  workspaceRoot: string,
): PermissionDecisionResult {
  return {
    ...decision,
    allowed: false,
    decision: "deny",
    escalated: false,
    reason: `File tool access is restricted to the workspace root (${workspaceRoot})`,
    ruleId: "workspace.file.scope",
  };
}

/**
 * glob 模式穿越的静态判定：含 `..` 路径段或以 `/` 开头（绝对 glob）即拒。
 * rg --glob 的 `!` 否定前缀剥掉后再判；字面包含 ".." 文件名的场景对值守会话
 * 一并保守拒绝（fail-closed），交互会话不受本模块影响。
 */
function patternKeyEscapesRoot(toolName: string, record: Record<string, unknown>): boolean {
  const keys = FILE_SCOPE_PATTERN_KEYS.get(toolName);
  if (!keys) return false;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const pattern = value.startsWith("!") ? value.slice(1) : value;
    if (isAbsolute(pattern)) return true;
    if (pattern.split(/[\\/]+/u).includes("..")) return true;
  }
  return false;
}

/**
 * 解析已存在部分的 realpath：目标不存在时逐级上溯到最近的存在祖先，把不存在的
 * 尾段拼回去。不存在尾段的包含关系已由字符串层判定兜底（符号链接必须已存在才
 * 能指向别处，realpath 掉的部分就是全部风险面）。
 */
async function realPathLongestExisting(target: string): Promise<string> {
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix.length > 0 ? `${real}/${suffix.join("/")}` : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      suffix.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
