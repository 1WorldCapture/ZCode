import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentHomeAdapter } from "../src/raft-agents/adapters/agentHome.js";
import {
  renderAgentsTemplate,
  renderMemoryTemplate,
  sanitizeInline,
} from "../src/raft-agents/domain/agentHomeTemplates.js";

test("模板：三段结构，名称/描述被压成单行且不能伪造标题", () => {
  const memory = renderMemoryTemplate({
    agentName: "Bot\n# 伪造标题\u0000",
    description: "职责一\n\n## Role\n注入",
  });
  assert.ok(memory.startsWith("# Bot # 伪造标题\n"));
  assert.match(memory, /## Role\n职责一 ## Role 注入\n/);
  assert.ok(memory.includes("## Key Knowledge") && memory.includes("## Active Context"));
  assert.equal(
    (memory.match(/^## Role$/gm) ?? []).length,
    1,
    "描述里的换行不能制造第二个 Role 标题",
  );
  assert.ok(renderMemoryTemplate({ agentName: "x" }).includes("尚未定义职责。"));
});

test("模板：值里的 {{占位符}} 不被二次展开；超长被截断", () => {
  const memory = renderMemoryTemplate({
    agentName: "{{description}}",
    description: "d".repeat(2000),
  });
  assert.ok(memory.startsWith("# {{description}}\n"));
  assert.ok(sanitizeInline("a".repeat(600), 500, "f").length <= 501);
  const agents = renderAgentsTemplate({ agentName: "Bot" });
  assert.ok(agents.includes("Bot 的工作区指引") && agents.includes("不由本目录里的任何文件决定"));
});

test("initialize：创建 MEMORY.md/AGENTS.md/notes/，已有文件永不覆盖，可重复调用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const home = join(dir, "agents", "b1", "workspace");
    const adapter = createAgentHomeAdapter();
    await adapter.initialize({ bindingId: "b1", displayName: "Reviewer", homeWorkspacePath: home });
    assert.ok((await stat(join(home, "notes"))).isDirectory());
    assert.ok((await readFile(join(home, "MEMORY.md"), "utf8")).startsWith("# Reviewer\n"));
    // 用户/Agent 改过的内容不被覆盖。
    await writeFile(join(home, "MEMORY.md"), "# 我改过的\n重要记忆\n");
    await adapter.initialize({ bindingId: "b1", displayName: "Reviewer", homeWorkspacePath: home });
    assert.equal(await readFile(join(home, "MEMORY.md"), "utf8"), "# 我改过的\n重要记忆\n");
    if (process.platform !== "win32") {
      assert.equal((await stat(join(home, "MEMORY.md"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyMemoryAvailable：可区分的失败原因，且只读不创建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const adapter = createAgentHomeAdapter();
    const home = join(dir, "home");
    assert.deepEqual(await adapter.verifyMemoryAvailable({ homeWorkspacePath: home }), {
      ok: false,
      code: "HomeMissing",
    });
    await assert.rejects(() => stat(home), "校验不得创建 Home");

    await mkdir(home, { recursive: true });
    assert.deepEqual(await adapter.verifyMemoryAvailable({ homeWorkspacePath: home }), {
      ok: false,
      code: "MemoryMissing",
    });

    await writeFile(join(home, "MEMORY.md"), "  \n\t");
    assert.deepEqual(await adapter.verifyMemoryAvailable({ homeWorkspacePath: home }), {
      ok: false,
      code: "MemoryEmpty",
    });

    await writeFile(join(home, "MEMORY.md"), "# 有内容\n");
    assert.deepEqual(await adapter.verifyMemoryAvailable({ homeWorkspacePath: home }), {
      ok: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyMemoryAvailable：MEMORY.md 是符号链接或目录时拒绝（不把任意文件读进上下文）", async (t) => {
  if (process.platform === "win32") return t.skip("符号链接需要权限");
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const adapter = createAgentHomeAdapter();
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(dir, "secret.txt"), "secret");
    await symlink(join(dir, "secret.txt"), join(home, "MEMORY.md"));
    const linked = await adapter.verifyMemoryAvailable({ homeWorkspacePath: home });
    assert.equal(linked.ok === false && linked.code, "MemoryUnreadable");

    const home2 = join(dir, "home2");
    await mkdir(join(home2, "MEMORY.md"), { recursive: true });
    const dirAsFile = await adapter.verifyMemoryAvailable({ homeWorkspacePath: home2 });
    assert.equal(dirAsFile.ok === false && dirAsFile.code, "MemoryUnreadable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("截断按码点：不在代理对中间劈开", () => {
  const emojiName = "😀".repeat(200);
  const clipped = sanitizeInline(emojiName, 120, "f");
  assert.equal(Array.from(clipped.replace("…", "")).length, 120);
  assert.ok(
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(clipped),
    "不得出现孤立代理项",
  );
});

// ── 二期 A1 删除守卫（评审定稿：符号链接拒绝 / 保护根拒绝 / 归属标记判定）──

const MARKER = ".zcode-agent-home";

test("claimHomeOwnership：新建或空目录独占写标记；非空用户目录不写；重复声明不覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const adapter = createAgentHomeAdapter();
    // 不存在 → 创建并写标记。
    const fresh = join(dir, "fresh");
    await adapter.claimHomeOwnership({ homeWorkspacePath: fresh, bindingId: "b-1" });
    assert.equal((await readFile(join(fresh, MARKER), "utf8")).trim(), "b-1");
    // 已有标记（wx）不覆盖：第二次声明不同 binding 不改变归属。
    await adapter.claimHomeOwnership({ homeWorkspacePath: fresh, bindingId: "b-2" });
    assert.equal((await readFile(join(fresh, MARKER), "utf8")).trim(), "b-1");
    // 空目录（已存在）也视为 ZCode 接管。
    const empty = join(dir, "empty");
    await mkdir(empty);
    await adapter.claimHomeOwnership({ homeWorkspacePath: empty, bindingId: "b-1" });
    assert.equal((await readFile(join(empty, MARKER), "utf8")).trim(), "b-1");
    // 非空目录 = 用户自选：不写标记。
    const userDir = join(dir, "user");
    await mkdir(userDir);
    await writeFile(join(userDir, "keep.txt"), "user data");
    await adapter.claimHomeOwnership({ homeWorkspacePath: userDir, bindingId: "b-1" });
    await assert.rejects(readFile(join(userDir, MARKER)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteHome：Home 路径本身是符号链接 → 拒绝，链接目标整树保全", async (t) => {
  if (process.platform === "win32") return t.skip("符号链接需要权限");
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const adapter = createAgentHomeAdapter();
    const project = join(dir, "real-project");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "# 项目自有\n");
    await writeFile(join(project, "src", "main.ts"), "code");
    const linkedHome = join(dir, "linked-home");
    await symlink(project, linkedHome);

    const result = await adapter.deleteHome({
      homeWorkspacePath: linkedHome,
      dataRootDir: join(dir, "data-root"),
      bindingId: "b-1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "Refused");
    // 链接目标原样保留（这是评审实测能删掉真实项目目录的缺陷回归用例）。
    assert.equal(await readFile(join(project, "src", "main.ts"), "utf8"), "code");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteHome：用户主目录上级与数据根本身拒绝；根目录拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const adapter = createAgentHomeAdapter();
    const dataRoot = join(dir, "data-root");
    await mkdir(join(dataRoot, "agents", "b-1", "workspace"), { recursive: true });
    // 数据根本身。
    const asDataRoot = await adapter.deleteHome({
      homeWorkspacePath: dataRoot,
      dataRootDir: dataRoot,
      bindingId: "b-1",
    });
    assert.equal(asDataRoot.ok, false);
    // 数据根的上级。
    const asDataRootParent = await adapter.deleteHome({
      homeWorkspacePath: dir,
      dataRootDir: dataRoot,
      bindingId: "b-1",
    });
    assert.equal(asDataRootParent.ok === false && asDataRootParent.code, "Refused");
    // 用户主目录的上级（如 /Users）——真实路径形态。
    const { dirname } = await import("node:path");
    const { homedir } = await import("node:os");
    const asHomeAncestor = await adapter.deleteHome({
      homeWorkspacePath: dirname(homedir()),
      dataRootDir: dataRoot,
      bindingId: "b-1",
    });
    assert.equal(asHomeAncestor.ok === false && asHomeAncestor.code, "Refused");
    const asRoot = await adapter.deleteHome({ homeWorkspacePath: "/", dataRootDir: dataRoot, bindingId: "b-1" });
    assert.equal(asRoot.ok === false && asRoot.code, "Refused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteHome：归属成立（标记匹配或默认位置）整删；不成立只清记忆面并保留目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-home-"));
  try {
    const adapter = createAgentHomeAdapter();
    const dataRoot = join(dir, "data-root");

    // 默认位置（无标记，兼容加标记前的旧绑定）→ 整删。
    const legacy = join(dataRoot, "agents", "b-1", "workspace");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "# legacy\n");
    const legacyResult = await adapter.deleteHome({
      homeWorkspacePath: legacy,
      dataRootDir: dataRoot,
      bindingId: "b-1",
    });
    assert.deepEqual(legacyResult, { ok: true, home: "deleted" });
    await assert.rejects(stat(legacy));

    // 自选路径 + 标记匹配 → 整删。
    const claimed = join(dir, "claimed-home");
    await adapter.claimHomeOwnership({ homeWorkspacePath: claimed, bindingId: "b-2" });
    await adapter.initialize({ bindingId: "b-2", displayName: "T", homeWorkspacePath: claimed });
    const claimedResult = await adapter.deleteHome({
      homeWorkspacePath: claimed,
      dataRootDir: dataRoot,
      bindingId: "b-2",
    });
    assert.deepEqual(claimedResult, { ok: true, home: "deleted" });
    await assert.rejects(stat(claimed));

    // 自选路径无标记（用户目录）→ 保留目录，清记忆三处，home="kept_memory_cleared"。
    const userHome = join(dir, "user-home");
    await mkdir(join(userHome, "notes", "deep"), { recursive: true });
    await mkdir(join(userHome, "projects", "repo"), { recursive: true });
    await writeFile(join(userHome, "MEMORY.md"), "# 记忆\n");
    await writeFile(join(userHome, "AGENTS.md"), "# 指引\n");
    await writeFile(join(userHome, "notes", "deep", "a.md"), "旧记忆");
    await writeFile(join(userHome, "projects", "repo", "file.txt"), "project artifact");
    const keptResult = await adapter.deleteHome({
      homeWorkspacePath: userHome,
      dataRootDir: dataRoot,
      bindingId: "b-2",
    });
    assert.deepEqual(keptResult, { ok: true, home: "kept_memory_cleared" });
    await assert.rejects(readFile(join(userHome, "MEMORY.md")));
    await assert.rejects(readFile(join(userHome, "notes", "deep", "a.md")));
    assert.equal(await readFile(join(userHome, "projects", "repo", "file.txt"), "utf8"), "project artifact");
    assert.ok((await stat(userHome)).isDirectory(), "用户目录本身保留");

    // 标记不匹配（他绑定的标记）→ 同保留分支，且过期标记被清掉。
    const mismatch = join(dir, "mismatch-home");
    await mkdir(mismatch, { recursive: true });
    await writeFile(join(mismatch, MARKER), "other-binding\n");
    await writeFile(join(mismatch, "MEMORY.md"), "# 记忆\n");
    const mismatchResult = await adapter.deleteHome({
      homeWorkspacePath: mismatch,
      dataRootDir: dataRoot,
      bindingId: "b-2",
    });
    assert.deepEqual(mismatchResult, { ok: true, home: "kept_memory_cleared" });
    await assert.rejects(readFile(join(mismatch, MARKER)));
    assert.ok((await stat(mismatch)).isDirectory());

    // 目录不存在 → 幂等成功（终态等价于已删除）。
    const missing = await adapter.deleteHome({
      homeWorkspacePath: join(dir, "nope"),
      dataRootDir: dataRoot,
      bindingId: "b-2",
    });
    assert.deepEqual(missing, { ok: true, home: "deleted" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteHome：默认位置整删顺带清空壳 agents/<id>/；非默认/非空父目录不动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-home-shell-"));
  try {
    const adapter = createAgentHomeAdapter();
    const dataRoot = join(dir, "data-root");

    // 默认位置整删：agents/<b-9>/ 空壳一并移除（收尾缺陷：残留空目录）。
    const home = join(dataRoot, "agents", "b-9", "workspace");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "MEMORY.md"), "# legacy\n");
    const deleted = await adapter.deleteHome({
      homeWorkspacePath: home,
      dataRootDir: dataRoot,
      bindingId: "b-9",
    });
    assert.deepEqual(deleted, { ok: true, home: "deleted" });
    await assert.rejects(stat(join(dataRoot, "agents", "b-9")), "空壳 agents/<id>/ 不再残留");
    assert.ok((await stat(join(dataRoot, "agents"))).isDirectory(), "agents/ 容器保留（不向上递归）");

    // 默认位置但父目录非空（workspace 之外还有内容）→ 只删 workspace，壳保留。
    const busy = join(dataRoot, "agents", "b-8", "workspace");
    await mkdir(busy, { recursive: true });
    await mkdir(join(dataRoot, "agents", "b-8", "logs"), { recursive: true });
    await writeFile(join(dataRoot, "agents", "b-8", "logs", "x.log"), "keep");
    const busyResult = await adapter.deleteHome({
      homeWorkspacePath: busy,
      dataRootDir: dataRoot,
      bindingId: "b-8",
    });
    assert.deepEqual(busyResult, { ok: true, home: "deleted" });
    await assert.rejects(stat(busy));
    assert.equal(
      await readFile(join(dataRoot, "agents", "b-8", "logs", "x.log"), "utf8"),
      "keep",
      "父目录有他物时壳与其内容保留",
    );

    // 非默认位置（自选路径 + 标记匹配）：只整删 Home 本身，不碰其上层目录结构。
    const claimedParent = join(dir, "my-homes");
    const claimed = join(claimedParent, "agent-x");
    await adapter.claimHomeOwnership({ homeWorkspacePath: claimed, bindingId: "b-7" });
    const claimedResult = await adapter.deleteHome({
      homeWorkspacePath: claimed,
      dataRootDir: dataRoot,
      bindingId: "b-7",
    });
    assert.deepEqual(claimedResult, { ok: true, home: "deleted" });
    await assert.rejects(stat(claimed));
    assert.ok((await stat(claimedParent)).isDirectory(), "非默认派生的父目录不在清理范围");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
