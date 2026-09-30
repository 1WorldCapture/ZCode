import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkspaceFileScopePermission,
} from "../src/tool/executor/workspace-file-scope.js";
import { isResolvedPathInsideRoot } from "../src/tool/path-policy.js";
import type { PermissionDecisionResult } from "../src/permission/service.js";

const WORKSPACE = "/data/agents/b1/workspace";
const ALLOWED: PermissionDecisionResult = {
  decision: "allow",
  allowed: true,
  escalated: false,
  mode: "yolo",
  ruleId: "mode.yolo",
  riskLevel: "low",
};

function scopeDecision(input: {
  enabled?: boolean;
  toolName: string;
  input: unknown;
  workingDirectory?: string;
}): PermissionDecisionResult {
  return applyWorkspaceFileScopePermission({
    decision: ALLOWED,
    enabled: input.enabled ?? true,
    executionInput: input.input,
    toolName: input.toolName,
    workingDirectory: input.workingDirectory ?? WORKSPACE,
    workspaceRoot: WORKSPACE,
  });
}

test("isResolvedPathInsideRoot：根内真、根外/根本身/.. 逃逸假", () => {
  assert.equal(isResolvedPathInsideRoot(`${WORKSPACE}/notes/a.md`, WORKSPACE), true);
  assert.equal(isResolvedPathInsideRoot(WORKSPACE, WORKSPACE), false, "根本身算外（目标是文件）");
  assert.equal(isResolvedPathInsideRoot("/etc/hosts", WORKSPACE), false);
  assert.equal(isResolvedPathInsideRoot("/data/agents/b1/workspace-evil/x", WORKSPACE), false);
  assert.equal(isResolvedPathInsideRoot("/data/agents", WORKSPACE), false, "父目录算外");
});

test("开启后：根内路径放行，绝对/相对/.. 逃逸一律 deny", () => {
  assert.equal(scopeDecision({ toolName: "Write", input: { file_path: `${WORKSPACE}/MEMORY.md` } }).allowed, true);
  // 相对路径按 workingDirectory 解析，仍在根内 → 放行。
  assert.equal(scopeDecision({ toolName: "Read", input: { file_path: "notes/a.md" } }).allowed, true);
  // .. 逃逸与绝对路径逃逸 → deny（yolo 放行被压回）。
  const escape = scopeDecision({ toolName: "Write", input: { file_path: "../../etc/cron.d/x" } });
  assert.equal(escape.allowed, false);
  assert.equal(escape.decision, "deny");
  assert.equal(escape.ruleId, "workspace.file.scope");
  assert.equal(scopeDecision({ toolName: "Read", input: { file_path: "/etc/passwd" } }).allowed, false);
  // 多路径键任一越界即拒绝（Grep 的 path + cwd）。
  assert.equal(
    scopeDecision({ toolName: "Grep", input: { pattern: "x", path: WORKSPACE, cwd: "/etc" } }).allowed,
    false,
  );
});

test("白名单外工具与未开启时不动决策；缺省路径键按 cwd 落根内", () => {
  // 非 Read/Write/Edit/Glob/Grep（含 ApplyPatch——刻意不在值守白名单）不受影响。
  assert.equal(scopeDecision({ toolName: "ApplyPatch", input: { patch_text: "x" } }).allowed, true);
  assert.equal(scopeDecision({ toolName: "TodoWrite", input: { todos: [] } }).allowed, true);
  // 未开启（普通会话）完全不拦截。
  assert.equal(
    scopeDecision({ enabled: false, toolName: "Read", input: { file_path: "/etc/hosts" } }).allowed,
    true,
  );
  // Glob/Grep 缺省 path/cwd → 解析为 workingDirectory（= workspace 根）→ 放行。
  assert.equal(scopeDecision({ toolName: "Glob", input: { pattern: "**/*.md" } }).allowed, true);
});

test("deny 结果保留原 mode 等字段且不可再被放行分支改写（结构面）", () => {
  const denied = scopeDecision({ toolName: "Edit", input: { file_path: "/tmp/x" } });
  assert.equal(denied.mode, "yolo");
  assert.equal(denied.escalated, false);
  assert.ok(denied.reason?.includes(WORKSPACE), "拒绝理由带根路径，模型可自行改用根内路径");
});
