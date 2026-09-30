import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
// @ts-expect-error 构建脚本是 .mjs，无类型声明。
import { buildRaftAgentToolsBundle } from "../scripts/build.mjs";
import { formatToolResult, listRaftTools, toToolCall } from "../src/server.js";

test("工具列表：6 个白名单工具，无身份字段", () => {
  const tools = listRaftTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["raft_message_check", "raft_message_read", "raft_message_send", "raft_task_list", "raft_task_claim", "raft_task_update"],
  );
  const schemaText = JSON.stringify(tools);
  assert.ok(!/profile|server|token/i.test(schemaText.replace(/服务/g, "")), "入参里不应出现身份字段");
});

test("入参映射：未知字段与 done 状态被拒", () => {
  assert.equal(toToolCall("raft_message_check", { profile: "evil" }).ok, false);
  assert.equal(toToolCall("raft_task_update", { target: "#dev", number: 1, status: "done" }).ok, false);
  assert.equal(toToolCall("nope", {}).ok, false);
  const ok = toToolCall("raft_message_send", { target: "#dev", content: "hi" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.call, { tool: "message_send", target: "#dev", content: "hi" });
});

test("结果格式化：held 引导模型三选一，unknown 是错误并禁止重发", () => {
  const held = formatToolResult({ kind: "held", text: "新消息 A" });
  assert.equal(held.isError, undefined);
  assert.ok(held.content[0]?.text.includes("sendDraft:true") && held.content[0].text.includes("新消息 A"));
  const unknown = formatToolResult({ kind: "unknown", text: "x" });
  assert.equal(unknown.isError, true);
  assert.ok(unknown.content[0]?.text.includes("不要重发"));
});

test("stdio 端到端：真实 MCP 客户端调用构建产物，check 先落盘、done 被拒", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-e2e-"));
  try {
    const bundle = join(dir, "dist", "mcp", "server.js");
    await buildRaftAgentToolsBundle({ outfile: bundle });
    const cli = join(dir, "fake-raft.mjs");
    await writeFile(
      cli,
      `#!/usr/bin/env node\nprocess.stdout.write("[target=#dev msg=aaaa1111 time=t type=human] @lyon: hi\\nNo more new inbox messages.\\n");`,
    );
    await chmod(cli, 0o755);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(bundle)],
      env: {
        ...(process.env as Record<string, string>),
        ZCODE_RAFT_BINDING_ID: "bind-1",
        ZCODE_RAFT_CLI_PATH: cli,
        ZCODE_RAFT_PROFILE_SLUG: "raft-x",
        ZCODE_RAFT_PROFILE_DIR: join(dir, "profile"),
        ZCODE_RAFT_DATA_ROOT: dir,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "e2e", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(transport);
    try {
      assert.equal((await client.listTools()).tools.length, 6);
      const checked = await client.callTool({ name: "raft_message_check", arguments: {} });
      assert.ok(JSON.stringify(checked.content).includes("aaaa1111"));
      assert.equal((await readdir(join(dir, "raft", "inbox-logs", "bind-1"))).length, 1);
      const rejected = await client.callTool({
        name: "raft_task_update",
        arguments: { target: "#dev", number: 1, status: "done" },
      });
      assert.equal(rejected.isError, true);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
