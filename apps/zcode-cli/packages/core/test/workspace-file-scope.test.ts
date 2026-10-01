import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWorkspaceFileScopePermission } from "../src/tool/executor/workspace-file-scope.js";
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
  workspaceRoot?: string;
}): Promise<PermissionDecisionResult> {
  return applyWorkspaceFileScopePermission({
    decision: ALLOWED,
    enabled: input.enabled ?? true,
    executionInput: input.input,
    toolName: input.toolName,
    workingDirectory: input.workingDirectory ?? WORKSPACE,
    workspaceRoot: input.workspaceRoot ?? WORKSPACE,
  });
}

test("isResolvedPathInsideRoot：根内真、根外/根本身/.. 逃逸假", () => {
  assert.equal(isResolvedPathInsideRoot(`${WORKSPACE}/notes/a.md`, WORKSPACE), true);
  assert.equal(isResolvedPathInsideRoot(WORKSPACE, WORKSPACE), false, "根本身算外（目标是文件）");
  assert.equal(isResolvedPathInsideRoot("/etc/hosts", WORKSPACE), false);
  assert.equal(isResolvedPathInsideRoot("/data/agents/b1/workspace-evil/x", WORKSPACE), false);
  assert.equal(isResolvedPathInsideRoot("/data/agents", WORKSPACE), false, "父目录算外");
});

test("开启后：根内路径放行，绝对/相对/.. 逃逸一律 deny", async () => {
  assert.equal(
    (await scopeDecision({ toolName: "Write", input: { file_path: `${WORKSPACE}/MEMORY.md` } })).allowed,
    true,
  );
  // 相对路径按 workingDirectory 解析，仍在根内 → 放行。
  assert.equal((await scopeDecision({ toolName: "Read", input: { file_path: "notes/a.md" } })).allowed, true);
  // .. 逃逸与绝对路径逃逸 → deny（yolo 放行被压回）。
  const escape = await scopeDecision({ toolName: "Write", input: { file_path: "../../etc/cron.d/x" } });
  assert.equal(escape.allowed, false);
  assert.equal(escape.decision, "deny");
  assert.equal(escape.ruleId, "workspace.file.scope");
  assert.equal((await scopeDecision({ toolName: "Read", input: { file_path: "/etc/passwd" } })).allowed, false);
  // 多路径键任一越界即拒绝（Grep 的 path + cwd）。
  assert.equal(
    (
      await scopeDecision({
        toolName: "Grep",
        input: { pattern: "x", path: WORKSPACE, cwd: "/etc" },
      })
    ).allowed,
    false,
  );
});

test("Glob/Grep 搜索范围允许等于工作区根（审核 D2）；Read/Write/Edit 仍拒绝根本身", async () => {
  // 模型常显式传根路径或 "." 作为搜索目录——等于根不算越界。
  assert.equal(
    (await scopeDecision({ toolName: "Glob", input: { pattern: "**/*.md", path: WORKSPACE } })).allowed,
    true,
  );
  assert.equal(
    (await scopeDecision({ toolName: "Glob", input: { pattern: "**/*.md", path: "." } })).allowed,
    true,
  );
  assert.equal((await scopeDecision({ toolName: "Grep", input: { pattern: "x", cwd: WORKSPACE } })).allowed, true);
  // 文件类工具的目标是文件：根本身照旧拒绝（行为不变）。
  assert.equal((await scopeDecision({ toolName: "Read", input: { file_path: WORKSPACE } })).allowed, false);
  assert.equal((await scopeDecision({ toolName: "Write", input: { file_path: WORKSPACE } })).allowed, false);
  // 等于根的例外不放宽越界：范围键指到根外仍然拒绝。
  assert.equal((await scopeDecision({ toolName: "Glob", input: { pattern: "x", path: "/etc" } })).allowed, false);
  assert.equal((await scopeDecision({ toolName: "Grep", input: { pattern: "x", path: "/etc" } })).allowed, false);
});

test("安全矩阵（评审定稿）：凭据文件、邻居 Home、glob 穿越全拒", async () => {
  // Raft 明文凭据就在 Home 外面，读取即外带。
  assert.equal(
    (
      await scopeDecision({
        toolName: "Read",
        input: { file_path: "/data/raft/profiles/agent-a/credential.json" },
      })
    ).allowed,
    false,
  );
  // 另一个 agent 的 Home（兄弟目录，字符串前缀不同）。
  assert.equal(
    (await scopeDecision({ toolName: "Read", input: { file_path: "/data/agents/b2/workspace/MEMORY.md" } }))
      .allowed,
    false,
  );
  // Glob 模式带 .. 段 / 绝对路径前缀 → 拒（path 本身在根内也不行）。
  assert.equal(
    (await scopeDecision({ toolName: "Glob", input: { pattern: "../**/*.pub", path: WORKSPACE } })).allowed,
    false,
  );
  assert.equal(
    (await scopeDecision({ toolName: "Glob", input: { pattern: "/etc/**", path: WORKSPACE } })).allowed,
    false,
  );
  // rg --glob 文件过滤器带穿越同理；内容正则（Grep.pattern）不在此列。
  assert.equal(
    (await scopeDecision({ toolName: "Grep", input: { pattern: "token", glob: "../creds/*" } })).allowed,
    false,
  );
  assert.equal(
    (await scopeDecision({ toolName: "Grep", input: { pattern: "sk_agent_...", glob: "*.json" } })).allowed,
    true,
  );
});

test("符号链接：Home 内指向外部的链接被 realpath 解析后拒绝（posix）", async (t) => {
  if (process.platform === "win32") return t.skip("符号链接 fixtures 仅 posix");
  const base = await mkdtemp(join(tmpdir(), "wfscope-"));
  t.after(() => rm(base, { force: true, recursive: true }));
  const home = join(base, "home");
  const outside = join(base, "outside");
  await mkdir(join(home, "notes"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(home, "secret-link"));

  // 经符号链接的读：字符串层在根内，realpath 落到根外 → 拒。
  assert.equal(
    (await scopeDecision({ toolName: "Read", input: { file_path: join(home, "secret-link", "id_rsa") }, workspaceRoot: home }))
      .allowed,
    false,
  );
  // 根内正常文件不受影响。
  assert.equal(
    (
      await scopeDecision({
        toolName: "Write",
        input: { file_path: join(home, "notes", "a.md") },
        workspaceRoot: home,
      })
    ).allowed,
    true,
  );
  // Home 本身经符号链接路径给出时，规范路径写入不被误拒（根别名双向认可）。
  const homeAlias = join(base, "home-alias");
  await symlink(home, homeAlias);
  assert.equal(
    (
      await scopeDecision({
        toolName: "Read",
        input: { file_path: join(home, "notes", "a.md") },
        workspaceRoot: homeAlias,
      })
    ).allowed,
    true,
  );
});

test("白名单外工具与未开启时不动决策；缺省路径键按 cwd 落根内", async () => {
  // 非 Read/Write/Edit/Glob/Grep（含 ApplyPatch——刻意不在值守白名单）不受影响。
  assert.equal((await scopeDecision({ toolName: "ApplyPatch", input: { patch_text: "x" } })).allowed, true);
  assert.equal((await scopeDecision({ toolName: "TodoWrite", input: { todos: [] } })).allowed, true);
  // 未开启（普通会话）完全不拦截。
  assert.equal(
    (await scopeDecision({ enabled: false, toolName: "Read", input: { file_path: "/etc/hosts" } })).allowed,
    true,
  );
  // Glob/Grep 缺省 path/cwd → 解析为 workingDirectory（= workspace 根）→ 放行。
  assert.equal((await scopeDecision({ toolName: "Glob", input: { pattern: "**/*.md" } })).allowed, true);
});

test("deny 结果保留原 mode 等字段且不可再被放行分支改写（结构面）", async () => {
  const denied = await scopeDecision({ toolName: "Edit", input: { file_path: "/tmp/x" } });
  assert.equal(denied.mode, "yolo");
  assert.equal(denied.escalated, false);
  assert.ok(denied.reason?.includes(WORKSPACE), "拒绝理由带根路径，模型可自行改用根内路径");
});
