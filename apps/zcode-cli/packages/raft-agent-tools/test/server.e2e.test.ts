import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
// @ts-expect-error 构建脚本是 .mjs，无类型声明。
import { buildRaftAgentToolsBundle } from "../scripts/build.mjs";
import { formatToolResult, listRaftTools, toToolCall } from "../src/server.js";

test("工具列表：8 个白名单工具，入参无身份字段", () => {
  const tools = listRaftTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "raft_message_check",
      "raft_message_read",
      "raft_message_send",
      "raft_task_list",
      "raft_task_claim",
      "raft_task_update",
      "raft_server_info",
      "raft_channel_members",
    ],
  );
  // 身份字段检查只看入参 schema：工具名（raft_server_info）不是身份字段。
  const schemaText = JSON.stringify(tools.map((t) => t.inputSchema));
  assert.ok(!/profile|token/i.test(schemaText), "入参里不应出现身份字段");
});

test("入参映射：未知字段与 done 状态被拒", () => {
  assert.equal(toToolCall("raft_message_check", { profile: "evil" }).ok, false);
  assert.equal(toToolCall("raft_task_update", { target: "#dev", number: 1, status: "done" }).ok, false);
  assert.equal(toToolCall("nope", {}).ok, false);
  const ok = toToolCall("raft_message_send", { target: "#dev", content: "hi" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.call, { tool: "message_send", target: "#dev", content: "hi" });
  // 只读发现面：无参的 server_info 与带频道的 channel_members。
  // （target 的格式校验在 buildRaftCommand 层，与其他 task 工具同款分层。）
  assert.deepEqual(toToolCall("raft_server_info", {}), { ok: true, call: { tool: "server_info" } });
  assert.equal(toToolCall("raft_server_info", { profile: "evil" }).ok, false);
  const members = toToolCall("raft_channel_members", { target: "#dev" });
  assert.deepEqual(members.ok ? members.call : null, { tool: "channel_members", target: "#dev" });
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
      `#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("Raft CLI: 0.0.24\\n"); process.exit(0); }\nprocess.stdout.write("[target=#dev msg=aaaa1111 time=t type=human] @lyon: hi\\nNo more new inbox messages.\\n");`,
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
      assert.equal((await client.listTools()).tools.length, 8);
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

test("stdio 端到端（legacy 握手）：2025-era initialize 也必须连上并完成工具调用", async () => {
  // 宿主对 session 隔离的官方 MCP 连接发的是无 _meta envelope 的 2025-era initialize；
  // legacy:"reject" 时代这里握手被拒、真实会话的工具调用悬挂（e2e S4 第四层根因）。
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-e2e-legacy-"));
  try {
    const bundle = join(dir, "dist", "mcp", "server.js");
    await buildRaftAgentToolsBundle({ outfile: bundle });
    const cli = join(dir, "fake-raft.mjs");
    await writeFile(
      cli,
      `#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("Raft CLI: 0.0.24\\n"); process.exit(0); }\nprocess.stdout.write("[target=#dev msg=bbbb2222 time=t type=human] @lyon: yo\\nNo more new inbox messages.\\n");`,
    );
    await chmod(cli, 0o755);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(bundle)],
      env: {
        ...(process.env as Record<string, string>),
        ZCODE_RAFT_BINDING_ID: "bind-legacy",
        ZCODE_RAFT_CLI_PATH: cli,
        ZCODE_RAFT_PROFILE_SLUG: "raft-x",
        ZCODE_RAFT_PROFILE_DIR: join(dir, "profile"),
        ZCODE_RAFT_DATA_ROOT: dir,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "e2e-legacy", version: "1" }, { versionNegotiation: { mode: "legacy" } });
    await client.connect(transport);
    try {
      assert.equal((await client.listTools()).tools.length, 8);
      const checked = await client.callTool({ name: "raft_message_check", arguments: {} });
      assert.ok(JSON.stringify(checked.content).includes("bbbb2222"));
      assert.equal((await readdir(join(dir, "raft", "inbox-logs", "bind-legacy"))).length, 1);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("插件宿主路径：按宿主方式 import 构建产物并调用 main()，服务正常（e2e S4 第六层根因回归）", async () => {
  // 官方插件宿主（plugin-host-command.ts）import server.js 后调用导出的 main()。
  // 旧入口只顶层自启、不导出 main → 宿主报 "Plugin server does not export main()"
  // 退出子进程，连接闪断（连上→片刻断的竞态）。这里用同款宿主替身驱动构建产物。
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-e2e-host-"));
  try {
    const bundle = join(dir, "dist", "mcp", "server.js");
    await buildRaftAgentToolsBundle({ outfile: bundle });
    const cli = join(dir, "fake-raft.mjs");
    await writeFile(
      cli,
      `#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write("Raft CLI: 0.0.24\\n"); process.exit(0); }\nprocess.stdout.write("[target=#dev msg=cccc3333 time=t type=human] @lyon: host\\nNo more new inbox messages.\\n");`,
    );
    await chmod(cli, 0o755);
    const host = join(dir, "host.mjs");
    await writeFile(
      host,
      `import { pathToFileURL } from "node:url";
const module = await import(pathToFileURL(process.argv[2]).href);
if (typeof module.main !== "function") {
  process.stderr.write("Plugin server does not export main().\\n");
  process.exit(1);
}
await module.main();
`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(host), resolve(bundle)],
      env: {
        ...(process.env as Record<string, string>),
        ZCODE_RAFT_BINDING_ID: "bind-host",
        ZCODE_RAFT_CLI_PATH: cli,
        ZCODE_RAFT_PROFILE_SLUG: "raft-x",
        ZCODE_RAFT_PROFILE_DIR: join(dir, "profile"),
        ZCODE_RAFT_DATA_ROOT: dir,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "e2e-host", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(transport);
    try {
      assert.equal((await client.listTools()).tools.length, 8);
      const checked = await client.callTool({ name: "raft_message_check", arguments: {} });
      assert.ok(JSON.stringify(checked.content).includes("cccc3333"));
      assert.equal((await readdir(join(dir, "raft", "inbox-logs", "bind-host"))).length, 1);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("插件宿主路径：仅 import 不调用 main() 不得自启服务，且 main 必须是导出的函数", async () => {
  // 守卫直跑判定（isDirectMcpEntrypoint）：被 import 时顶层自启会让宿主调用与自启
  // 双重启动。这里验证 import 后对 initialize 请求无响应（未自启），并核验 main 导出形态。
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-e2e-nohost-"));
  try {
    const bundle = join(dir, "dist", "mcp", "server.js");
    await buildRaftAgentToolsBundle({ outfile: bundle });
    const probe = join(dir, "probe.mjs");
    await writeFile(
      probe,
      `import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const module = await import(pathToFileURL(process.argv[2]).href);
await writeFile(process.argv[3], JSON.stringify({ mainType: typeof module.main }));
setInterval(() => {}, 1000);
`,
    );
    const resultFile = join(dir, "result.json");
    const child = spawn(process.execPath, [resolve(probe), resolve(bundle), resultFile], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    try {
      // 等 import 完成与直跑判定落地（判定含 realpath 异步 IO）。
      for (let i = 0; i < 50; i++) {
        try {
          await readFile(resultFile, "utf8");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const { mainType } = JSON.parse(await readFile(resultFile, "utf8")) as { mainType: string };
      assert.equal(mainType, "function");
      // 未调用 main()：对 initialize 不得有任何响应。
      await new Promise((r) => setTimeout(r, 300));
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
        })}\n`,
      );
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(out, "");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
