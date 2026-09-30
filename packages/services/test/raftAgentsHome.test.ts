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
