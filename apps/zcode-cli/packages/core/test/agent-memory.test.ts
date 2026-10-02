// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { AgentMemoryUnavailableError, sanitizeAgentName } from "../src/memory/agent-memory.js";
import { buildAgentMemorySection } from "../src/context/sections/agent-memory.js";
import { buildRequestUserContextSection } from "../src/context/sections/request-user-context.js";
import { resolveEnabledProjectMemoryRoot } from "../src/runtime/helpers/project-memory.js";
import { loadAgentMemoryIndexContent } from "../src/runtime/helpers/agent-memory-index.js";
import { scheduleProjectMemoryExtraction } from "../src/runtime/helpers/project-memory-extraction.js";

const HOME = "/data/agents/b1/workspace";

test("记忆根解析：agent 作用域 = Home，不受项目记忆开关影响；非主会话类型不适用", () => {
  const config = { memory: { enabled: false, agent: { homeRoot: HOME } } } as never;
  assert.equal(resolveEnabledProjectMemoryRoot(config, "/some/workspace"), HOME);
  const child = { taskType: "workflow_child", memory: { agent: { homeRoot: HOME } } } as never;
  assert.equal(resolveEnabledProjectMemoryRoot(child, "/some/workspace"), undefined);
  // 无 agent 时仍走项目记忆规则（未开启 → undefined）。
  assert.equal(resolveEnabledProjectMemoryRoot({ memory: { enabled: false } } as never, "/w"), undefined);
});

test("agent 记忆 section：raft-agent 规则，名称被压成单行，不含项目记忆模板", () => {
  const section = buildAgentMemorySection(HOME, "Bot\n# 伪造标题");
  assert.ok(section);
  assert.ok(section.content.includes("你是 Bot # 伪造标题。"));
  assert.ok(section.content.includes("Active Context") && section.content.includes("绝不**把 token"));
  assert.ok(!section.content.includes("one fact"), "不得混入项目记忆的一事实一文件模板");
  assert.equal(buildAgentMemorySection(undefined, "x"), null);
  assert.equal(sanitizeAgentName("  "), "Raft Agent");
  assert.ok(sanitizeAgentName("x".repeat(500)).length <= 121);
});

test("MEMORY 索引在请求上下文里的标签区分 agent 与项目记忆", () => {
  const agent = buildRequestUserContextSection({ memoryRoot: HOME, memoryIndexContent: "# 记忆\n- a", agentMemory: true });
  assert.ok(agent?.content.includes("your Agent Home memory index"));
  const project = buildRequestUserContextSection({ memoryRoot: HOME, memoryIndexContent: "# 记忆\n- a" });
  assert.ok(project?.content.includes("user's auto-memory"));
});

function fakeRuntime(files: Record<string, { kind: string; content?: string }>, opts: { readThrows?: boolean } = {}) {
  const readFileState = new Map<unknown, unknown>();
  return {
    readFileState,
    now: () => 1,
    fileSystemPort: {
      stat: async ({ path }: { path: string }) => ({ path, kind: files[path]?.kind ?? "missing", sizeBytes: 1 }),
      readTextFile: async ({ path }: { path: string }) => {
        if (opts.readThrows) throw new Error("EACCES");
        return { content: files[path]?.content ?? "", sizeBytes: 1 };
      },
    },
  } as never;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AgentMemoryUnavailableError ? error.code : `other:${String(error)}`;
  }
}

test("严格加载：Home/MEMORY 缺失、非普通文件、不可读、为空都抛可区分的错误", async () => {
  const index = `${HOME}/MEMORY.md`;
  assert.equal(await code(loadAgentMemoryIndexContent(fakeRuntime({}), HOME)), "home_missing");
  assert.equal(await code(loadAgentMemoryIndexContent(fakeRuntime({ [HOME]: { kind: "directory" } }), HOME)), "memory_missing");
  assert.equal(
    await code(loadAgentMemoryIndexContent(fakeRuntime({ [HOME]: { kind: "directory" }, [index]: { kind: "symlink" } }), HOME)),
    "memory_unreadable",
  );
  assert.equal(
    await code(loadAgentMemoryIndexContent(fakeRuntime({ [HOME]: { kind: "directory" }, [index]: { kind: "file" } }, { readThrows: true }), HOME)),
    "memory_unreadable",
  );
  assert.equal(
    await code(loadAgentMemoryIndexContent(fakeRuntime({ [HOME]: { kind: "directory" }, [index]: { kind: "file", content: " \n" } }), HOME)),
    "memory_empty",
  );
});

test("严格加载：正常返回原文并记录读取状态", async () => {
  const index = `${HOME}/MEMORY.md`;
  const runtime = fakeRuntime({ [HOME]: { kind: "directory" }, [index]: { kind: "file", content: "# Bot\n\n## Role\n审阅者\n" } });
  assert.equal(await loadAgentMemoryIndexContent(runtime, HOME), "# Bot\n\n## Role\n审阅者\n");
  assert.equal((runtime as unknown as { readFileState: Map<unknown, unknown> }).readFileState.size, 1);
});

test("项目记忆自动抽取：agent 会话直接跳过（不触碰后续依赖）", () => {
  // 缺少 isRemoteWorkspace/sessionStore 等依赖：若没有 agent 守卫，会在解析记忆根后抛 TypeError。
  const runtime = { shuttingDown: false, workspaceRoot: "/w", config: { memory: { enabled: true, cliStorageRoot: "/s", agent: { homeRoot: HOME } } } } as never;
  assert.doesNotThrow(() => scheduleProjectMemoryExtraction(runtime, { model: {} as never, traceContext: {} as never }));
});

test("名称截断按码点：不在代理对中间劈开", () => {
  const clipped = sanitizeAgentName("😀".repeat(300));
  assert.equal(Array.from(clipped.replace("…", "")).length, 120);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(clipped));
});
