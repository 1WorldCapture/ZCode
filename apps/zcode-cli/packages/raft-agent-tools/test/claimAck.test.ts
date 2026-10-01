/**
 * 二期 A3：fork 命令行（`-zcode.N`）下的「claim → 落盘 → ack」与发送去重/回执。
 * 假 CLI 按子命令脚本化应答，并把每次调用的 argv/stdin 追加到 calls.jsonl。
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCliToolAdapter, type RaftToolIdentity } from "../src/cliToolAdapter.js";
import { createInboxLogStore } from "../src/inboxLogStore.js";
import type { InboxLogPort } from "../src/ports.js";
import { parseClaimedText } from "../src/toolCall.js";

const BINDING_ID = "11111111-2222-3333-4444-555555555555";
const ACK_LINE = "Claim-Ack: eyJ2IjoxLCJzIjpbNyw4XSwibSI6W10sInQiOltdfQ";
const CLAIM_OUTPUT = [
  "[target=#dev msg=aaaa1111 time=2026-09-30T00:00:00Z type=human] @lyon: 你好",
  "第二行正文",
  "[target=dm:@lyon msg=bbbb2222 time=2026-09-30T00:00:01Z type=human] @lyon: 在吗",
  "",
  "No more new inbox messages.",
  ACK_LINE,
  "",
].join("\n");

interface Reply {
  status: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}

async function makeScriptedCli(
  dir: string,
  version: string,
  replies: Record<string, Reply[]>,
) {
  const script = join(dir, "fake-raft.mjs");
  await writeFile(join(dir, "script.json"), JSON.stringify({ version, replies }));
  await writeFile(
    script,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const { version, replies } = JSON.parse(readFileSync(join(dir, "script.json"), "utf8"));
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv, stdin }) + "\\n");
  if (argv.includes("--version")) {
    if (existsSync(join(dir, "version-fail"))) { process.stderr.write("boom\\n"); process.exit(1); }
    process.stdout.write(version + "\\n"); process.exit(0);
  }
  const key = argv.slice(2, 4).join(" ");
  const counterFile = join(dir, "count-" + key.replace(/\\W/g, "_"));
  const n = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;
  writeFileSync(counterFile, String(n + 1));
  const queue = replies[key] ?? [{ status: 1, stderr: "Code: UNEXPECTED\\n" }];
  const reply = queue[Math.min(n, queue.length - 1)];
  if (reply.hang) return setTimeout(() => {}, 60000);
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exit(reply.status);
});
`,
  );
  await chmod(script, 0o755);
  return {
    script,
    calls: async () =>
      (await readFile(join(dir, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[]; stdin: string }),
  };
}

function identityFor(dir: string, cliPath: string): RaftToolIdentity {
  return { bindingId: BINDING_ID, cliPath, profileSlug: "raft-test", profileDir: join(dir, "profile") };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "raft-claim-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseClaimedText：剥除 Claim-Ack 与状态行，多行正文归入同一块", () => {
  const parsed = parseClaimedText(CLAIM_OUTPUT);
  assert.equal(parsed.ackLine, ACK_LINE);
  assert.equal(parsed.hasMore, false);
  assert.deepEqual(
    parsed.blocks.map((b) => [b.target, b.messageId]),
    [["#dev", "aaaa1111"], ["dm:@lyon", "bbbb2222"]],
  );
  assert.ok(parsed.blocks[0]?.text.endsWith("第二行正文"));
  assert.equal(parseClaimedText("More messages are pending. Ack this batch, then run `raft message claim` again.\n").hasMore, true);
});

test("message_check：claim → 先落盘 → 再 ack；凭据只经 stdin，不进返回文本与日志", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message claim": [{ status: 0, stdout: CLAIM_OUTPUT }],
      "message ack": [{ status: 0, stdout: "Acked 2 inbox items.\n" }],
    });
    const store = createInboxLogStore(dir);
    const order: string[] = [];
    const inboxLog: InboxLogPort = {
      ...store,
      append: async (id, entry) => {
        order.push("journal");
        await store.append(id, entry);
      },
    };
    const logs: string[] = [];
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog,
      logger: { info: (m, f) => logs.push(JSON.stringify({ m, f })), warn: (m, f) => logs.push(JSON.stringify({ m, f })) },
    });
    const result = await adapter.invoke({ tool: "message_check" });
    assert.equal(result.kind, "ok");
    const text = result.kind === "ok" ? result.text : "";
    assert.ok(text.includes("@lyon: 你好\n第二行正文"));
    assert.ok(text.includes("No more new inbox messages."));
    assert.ok(!text.includes("Claim-Ack"), "凭据不得进模型可见输出");

    const calls = await cli.calls();
    const claimIdx = calls.findIndex((c) => c.argv.includes("claim"));
    const ack = calls.find((c) => c.argv.includes("ack"));
    assert.ok(claimIdx >= 0 && ack, "应依次调用 claim 与 ack");
    assert.deepEqual(ack.argv, ["--profile", "raft-test", "message", "ack"]);
    assert.equal(ack.stdin, `${ACK_LINE}\n`);
    assert.ok(calls.every((c) => !c.argv.some((a) => a.includes("eyJ"))), "凭据不进 argv");
    assert.deepEqual(order, ["journal"]);

    const entries = await store.list(BINDING_ID);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.messageIds, ["aaaa1111", "bbbb2222"]);
    assert.ok(!entries[0]?.text.includes("Claim-Ack"), "凭据不进收件日志");
    assert.ok(!logs.join("").includes("Claim-Ack") && !logs.join("").includes("你好"));
  });
});

test("message_check：落盘失败不 ack，消息仍交给模型并上报", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message claim": [{ status: 0, stdout: CLAIM_OUTPUT }],
      "message ack": [{ status: 0, stdout: "Acked 2 inbox items.\n" }],
    });
    const failures: string[] = [];
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: {
        append: async () => {
          throw new Error("disk full");
        },
        list: async () => [],
        purge: async () => 0,
        removeAll: async () => {},
      },
      failureSink: { onInboxLogWriteFailed: (_id, reason) => failures.push(reason) },
      sleep: async () => {},
    });
    const result = await adapter.invoke({ tool: "message_check" });
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.journalFailed, true);
    assert.ok(result.kind === "ok" && result.text.includes("@lyon: 在吗"));
    assert.deepEqual(failures, ["disk full"]);
    assert.ok(!(await cli.calls()).some((c) => c.argv.includes("ack")), "落盘失败不得 ack");
  });
});

test("message_check：未确认的同批消息再次 claim 时不再交给模型，但照样 ack", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message claim": [{ status: 0, stdout: CLAIM_OUTPUT }],
      // 第一次 ack 失败（例如网络），第二次成功。
      "message ack": [{ status: 1, stderr: "Code: SERVER_5XX\n" }, { status: 0, stdout: "Acked 2 inbox items.\n" }],
    });
    const store = createInboxLogStore(dir);
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: store });
    const first = await adapter.invoke({ tool: "message_check" });
    assert.ok(first.kind === "ok" && first.text.includes("aaaa1111"));
    const second = await adapter.invoke({ tool: "message_check" });
    assert.equal(second.kind, "ok");
    assert.equal(second.kind === "ok" && second.text, "No new inbox messages.\n");
    assert.equal((await store.list(BINDING_ID)).length, 1, "重复消息不再落盘");
    assert.equal((await cli.calls()).filter((c) => c.argv.includes("ack")).length, 2);

    // 新进程（如重启）从收件日志恢复去重集合。
    const restarted = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: store });
    const third = await restarted.invoke({ tool: "message_check" });
    assert.equal(third.kind === "ok" && third.text, "No new inbox messages.\n");
  });
});

test("message_send：带去重键；结果不确定时查回执，已提交按成功返回不重发", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message send": [{ status: 1, stderr: "Code: CANNOT_CONFIRM\n" }],
      "message receipt": [{ status: 0, stdout: JSON.stringify({ status: "sent", message_id: "m-123" }) }],
    });
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: createInboxLogStore(dir),
      newSendKey: () => "zcode:test:key-1",
    });
    const result = await adapter.invoke({ tool: "message_send", target: "#dev", content: "正文" });
    assert.equal(result.kind, "ok");
    assert.ok(result.kind === "ok" && /^Message sent to #dev\. Message ID: m-123/.test(result.text));
    const calls = await cli.calls();
    const sends = calls.filter((c) => c.argv.includes("send"));
    assert.equal(sends.length, 1, "已提交不得重发");
    assert.ok(sends[0]?.argv.includes("--idempotency-key=zcode:test:key-1"));
    assert.equal(sends[0]?.stdin, "正文");
    assert.deepEqual(
      calls.find((c) => c.argv.includes("receipt"))?.argv,
      ["--profile", "raft-test", "message", "receipt", "zcode:test:key-1", "--json"],
    );
  });
});

test("message_send：回执未提交时同一个键重试一次；仍不确定则 unknown 且不再重发", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message send": [
        { status: 1, stderr: "Code: CANNOT_CONFIRM\n" },
        { status: 0, stdout: "Message sent to #dev. Message ID: m-9\n" },
      ],
      "message receipt": [{ status: 0, stdout: JSON.stringify({ status: "not_found" }) }],
    });
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: createInboxLogStore(dir),
      newSendKey: () => "zcode:test:key-2",
    });
    const ok = await adapter.invoke({ tool: "message_send", target: "#dev", content: "x" });
    assert.equal(ok.kind, "ok");
    const sends = (await cli.calls()).filter((c) => c.argv.includes("send"));
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0]?.argv, sends[1]?.argv, "重试必须用同一个键");
  });

  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message send": [{ status: 1, stderr: "Code: CANNOT_CONFIRM\n" }],
      "message receipt": [{ status: 0, stdout: JSON.stringify({ status: "not_found" }) }],
    });
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: createInboxLogStore(dir) });
    const result = await adapter.invoke({ tool: "message_send", target: "#dev", content: "x" });
    assert.equal(result.kind, "unknown");
    assert.equal((await cli.calls()).filter((c) => c.argv.includes("send")).length, 2, "最多两次发送");
  });
});

test("message_send：被扣成草稿不查回执、不重试", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message send": [{ status: 1, stdout: "新消息 A", stderr: "Code: SEND_HELD_AS_DRAFT\n" }],
    });
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: createInboxLogStore(dir) });
    const result = await adapter.invoke({ tool: "message_send", target: "#dev", content: "x" });
    assert.equal(result.kind, "held");
    const calls = await cli.calls();
    assert.equal(calls.filter((c) => c.argv.includes("send")).length, 1);
    assert.ok(!calls.some((c) => c.argv.includes("receipt")));
  });
});

test("旧命令行（无 -zcode 后缀）回落第一期：message check、发送不带键", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24", {
      "message check": [{ status: 0, stdout: "[target=#dev msg=aaaa1111 time=t type=human] @lyon: hi\n" }],
      "message send": [{ status: 0, stdout: "Message sent to #dev. Message ID: m-1\n" }],
    });
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: createInboxLogStore(dir) });
    assert.equal((await adapter.invoke({ tool: "message_check" })).kind, "ok");
    assert.equal((await adapter.invoke({ tool: "message_send", target: "#dev", content: "x" })).kind, "ok");
    const calls = await cli.calls();
    assert.equal(calls.filter((c) => c.argv.includes("--version")).length, 1, "能力探测只做一次");
    assert.ok(!calls.some((c) => c.argv.includes("claim") || c.argv.includes("ack")));
    assert.ok(!calls.some((c) => c.argv.some((a) => a.startsWith("--idempotency-key"))));
  });
});

test("新命令行 + 未部署补丁的服务端：claim 路由缺失时回落 message check", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message claim": [{ status: 1, stderr: "Error: Unregistered internal route\nCode: CHECK_FAILED\n" }],
      "message check": [{ status: 0, stdout: "[target=#dev msg=aaaa1111 time=t type=human] @lyon: hi\n" }],
    });
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: createInboxLogStore(dir) });
    const first = await adapter.invoke({ tool: "message_check" });
    assert.ok(first.kind === "ok" && first.text.includes("@lyon: hi"));
    await adapter.invoke({ tool: "message_check" });
    const calls = await cli.calls();
    assert.equal(calls.filter((c) => c.argv.includes("claim")).length, 1, "回落后不再尝试 claim");
    assert.equal(calls.filter((c) => c.argv.includes("check")).length, 2);
  });
});

test("D9：版本探测瞬时失败不缓存、不回落旧路径；恢复后走 claim/ack", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "Raft CLI: 0.0.24-zcode.1", {
      "message claim": [{ status: 0, stdout: "No new messages.\n" }],
      "message send": [{ status: 0, stdout: "Message sent to #dev. Message ID: m-1\n" }],
    });
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: createInboxLogStore(dir) });
    await writeFile(join(dir, "version-fail"), "1");
    const failedCheck = await adapter.invoke({ tool: "message_check" });
    assert.equal(failedCheck.kind, "error");
    const failedSend = await adapter.invoke({ tool: "message_send", target: "#dev", content: "x" });
    assert.equal(failedSend.kind, "error");
    let calls = await cli.calls();
    assert.ok(!calls.some((c) => c.argv.includes("check") || c.argv.includes("send")), "探测失败时不得执行旧路径或发送");
    await rm(join(dir, "version-fail"));
    assert.equal((await adapter.invoke({ tool: "message_check" })).kind, "ok");
    calls = await cli.calls();
    assert.ok(calls.some((c) => c.argv.includes("claim")), "恢复后走 claim");
    assert.ok(!calls.some((c) => c.argv[0] === "message" && c.argv[1] === "check"));
    // 结论已缓存：之后不再探测。
    const probes = calls.filter((c) => c.argv.includes("--version")).length;
    await adapter.invoke({ tool: "message_check" });
    assert.equal((await cli.calls()).filter((c) => c.argv.includes("--version")).length, probes);
  });
});

test("D9：读不出版本号（空输出）同样视为探测未得结论", async () => {
  await withDir(async (dir) => {
    const cli = await makeScriptedCli(dir, "", {
      "message check": [{ status: 0, stdout: "x\n" }],
    });
    const adapter = createCliToolAdapter({ identity: identityFor(dir, cli.script), inboxLog: createInboxLogStore(dir) });
    assert.equal((await adapter.invoke({ tool: "message_check" })).kind, "error");
    assert.ok(!(await cli.calls()).some((c) => c.argv[1] === "check"));
  });
});
