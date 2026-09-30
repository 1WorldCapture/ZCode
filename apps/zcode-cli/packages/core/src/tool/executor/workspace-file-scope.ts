import type { PermissionDecisionResult } from "../../permission/service.js";
import { isResolvedPathInsideRoot, resolveWorkspacePath } from "../path-policy.js";

/**
 * 无人值守会话的文件工具边界（wire 参数 confineFileToolsToWorkspace）。
 *
 * 为什么独立于既有机制：yolo 放行在权限服务里排在项目 deny 规则之前；toolAllowlist
 * 只决定"注册了哪些工具"。两者都约束不了一个已注册文件工具指向哪里——而值守会话
 * 的写入根（workspaceRoot = Agent Home）一旦被越出，等价于把宿主机全盘文件交给
 * 一个由频道消息驱动的模型。本检查在执行边界收口，排在 yolo 放行之后，deny 可恢复。
 *
 * 覆盖面刻意收窄到路径入参可静态提取的工具：Read/Write/Edit/Glob/Grep。ApplyPatch
 * 的路径藏在 patch_text 里，无法低成本做同样的校验，因此无人值守会话的工具白名单
 * 直接不包含它（见 raft-agents 适配器）。Bash 不在值守白名单内，天然不经过这里。
 */

const FILE_SCOPE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);

/** 这些键在五个工具的输入 schema 里都是路径/cwd；其余键不参与路径解析。 */
const FILE_SCOPE_PATH_KEYS: readonly string[] = ["file_path", "path", "cwd"];

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

export function applyWorkspaceFileScopePermission(input: {
  decision: PermissionDecisionResult;
  enabled: boolean | undefined;
  executionInput: unknown;
  toolName: string;
  workingDirectory: string;
  workspaceRoot: string;
}): PermissionDecisionResult {
  if (!input.enabled || !FILE_SCOPE_TOOLS.has(input.toolName)) return input.decision;

  const operation = WRITE_TOOLS.has(input.toolName) ? "write" : "read";
  for (const target of extractFileScopePaths(input.executionInput)) {
    const resolvedPath = resolveWorkspacePath({
      inputPath: target,
      operation,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
    if (!isResolvedPathInsideRoot(resolvedPath, input.workspaceRoot)) {
      return {
        ...input.decision,
        allowed: false,
        decision: "deny",
        escalated: false,
        reason: `File tool access is restricted to the workspace root (${input.workspaceRoot})`,
        ruleId: "workspace.file.scope",
      };
    }
  }
  return input.decision;
}

/** 只提取字符串型路径键；缺失的键（如 Glob/Grep 缺省 path）按 cwd 解析，天然在根内。 */
function* extractFileScopePaths(executionInput: unknown): Generator<string> {
  if (!executionInput || typeof executionInput !== "object") return;
  const record = executionInput as Record<string, unknown>;
  for (const key of FILE_SCOPE_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) yield value;
  }
}
