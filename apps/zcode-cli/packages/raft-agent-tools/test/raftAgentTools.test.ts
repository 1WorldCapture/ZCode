import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCliToolAdapter,
  type RaftToolIdentity,
} from "../src/cliToolAdapter.js";
import { createInboxLogStore } from "../src/inboxLogStore.js";
import { buildRaftCommand, parseCheckedMessages } from "../src/toolCall.js";
import { clampInboxLogRetentionDays, type InboxLogPort } from "../src/ports.js";

const CHECK_OUTPUT = [
  "[target=#dev msg=aaaa1111 time=2026-09-30T00:00:00Z type=human] @lyon: 你好",
  "[target=dm:@lyon msg=bbbb2222 time=2026-09-30T00:00:01Z type=human] @lyon: 在吗",
  "No more new inbox messages.",
].join("\n");

/** 假 CLI：按 FAKE_MODE 文件决定行为，并把收到的 argv/env/stdin 记到 record.json。 */
async function makeFakeCli(
  dir: string,
  mode: { status: number; stdout?: string; stderr?: string; hang?: boolean },
) {
  const script = join(dir, "fake-raft.mjs");
  await writeFile(join(dir, "mode.json"), JSON.stringify(mode));
  await writeFile(
    script,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const mode = JSON.parse(readFileSync(join(dir, "mode.json"), "utf8"));
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  writeFileSync(join(dir, "record.json"), JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env), profileDir: process.env.RAFT_PROFILE_DIR, stdin }));
  if (mode.hang) return setTimeout(() => {}, 60000);
  if (mode.stdout) process.stdout.write(mode.stdout);
  if (mode.stderr) process.stderr.write(mode.stderr);
  process.exit(mode.status);
});
`,
  );
  await chmod(script, 0o755);
  return {
    script,
    readRecord: async () =>
      JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as {
        argv: string[];
        envKeys: string[];
        profileDir?: string;
        stdin: string;
      },
  };
}

function identityFor(dir: string, cliPath: string): RaftToolIdentity {
  return {
    bindingId: "11111111-2222-3333-4444-555555555555",
    cliPath,
    profileSlug: "raft-test",
    profileDir: join(dir, "profile"),
  };
}

test("buildRaftCommand：身份参数无法注入，取值统一 --flag=value", () => {
  const read = buildRaftCommand({ tool: "message_read", target: "#dev", limit: 5 });
  assert.ok(read.ok);
  assert.deepEqual(read.argv, ["message", "read", "--target=#dev", "--limit=5"]);
  // 以 - 开头的 target 被格式校验拒绝，不可能变成另一个选项。
  assert.equal(buildRaftCommand({ tool: "message_read", target: "--profile=evil" }).ok, false);
  assert.equal(
    buildRaftCommand({ tool: "message_read", target: "#dev", after: "--server=x" }).ok,
    false,
  );
  // 结构化工具入参里夹带额外字段也不会进入 argv。
  const extra = buildRaftCommand({ tool: "message_check", profile: "evil" } as never);
  assert.ok(extra.ok);
  assert.deepEqual(extra.argv, ["message", "check"]);
});

test("buildRaftCommand：task update 拒绝 done/closed，只放行 in_progress/in_review", () => {
  assert.equal(
    buildRaftCommand({ tool: "task_update", target: "#dev", number: 3, status: "done" }).ok,
    false,
  );
  assert.equal(
    buildRaftCommand({ tool: "task_update", target: "#dev", number: 3, status: "closed" }).ok,
    false,
  );
  const ok = buildRaftCommand({
    tool: "task_update",
    target: "#dev",
    number: 3,
    status: "in_review",
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.argv, [
    "task",
    "update",
    "--target=#dev",
    "--number=3",
    "--status=in_review",
  ]);
});

test("buildRaftCommand：send 正文走 stdin，sendDraft 与 content 互斥", () => {
  const send = buildRaftCommand({
    tool: "message_send",
    target: "#dev:abcdef12",
    content: "  hi  ",
  });
  assert.ok(send.ok);
  assert.equal(send.stdin, "  hi  ");
  assert.ok(!send.argv.some((a) => a.includes("hi")));
  assert.equal(buildRaftCommand({ tool: "message_send", target: "#dev", content: "" }).ok, false);
  assert.equal(
    buildRaftCommand({ tool: "message_send", target: "#dev", sendDraft: true, content: "x" }).ok,
    false,
  );
  const draft = buildRaftCommand({ tool: "message_send", target: "#dev", sendDraft: true });
  assert.ok(draft.ok);
  assert.deepEqual(draft.argv, ["message", "send", "--target=#dev", "--send-draft"]);
});

test("parseCheckedMessages：提取 messageId 与 target，无消息时为空", () => {
  const parsed = parseCheckedMessages(CHECK_OUTPUT);
  assert.deepEqual(parsed.messageIds, ["aaaa1111", "bbbb2222"]);
  assert.deepEqual(parsed.targets.sort(), ["#dev", "dm:@lyon"]);
  assert.deepEqual(parseCheckedMessages("No more new inbox messages.").messageIds, []);
});

test("适配器：固定 --profile 前缀，环境净化后只带 RAFT_PROFILE_DIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-"));
  try {
    process.env.RAFT_PROFILE = "should-not-leak";
    process.env.SLOCK_CLI_TRANSPORT_DIR = "should-not-leak";
    const cli = await makeFakeCli(dir, { status: 0, stdout: "ok" });
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: createInboxLogStore(dir),
    });
    const result = await adapter.invoke({ tool: "task_list", target: "#dev" });
    assert.equal(result.kind, "ok");
    const record = await cli.readRecord();
    assert.deepEqual(record.argv.slice(0, 2), ["--profile", "raft-test"]);
    assert.equal(record.profileDir, join(dir, "profile"));
    assert.ok(!record.envKeys.some((k) => k === "RAFT_PROFILE" || k.startsWith("SLOCK_")));
  } finally {
    delete process.env.RAFT_PROFILE;
    delete process.env.SLOCK_CLI_TRANSPORT_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("message_check：先落盘再返回，日志含正文且日志目录之外不记正文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-"));
  try {
    const cli = await makeFakeCli(dir, { status: 0, stdout: CHECK_OUTPUT });
    const store = createInboxLogStore(dir);
    const logs: string[] = [];
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: store,
      logger: {
        info: (m, f) => logs.push(JSON.stringify({ m, f })),
        warn: (m, f) => logs.push(JSON.stringify({ m, f })),
      },
    });
    const result = await adapter.invoke({ tool: "message_check" });
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.text, CHECK_OUTPUT);
    const entries = await store.list("11111111-2222-3333-4444-555555555555");
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.messageIds, ["aaaa1111", "bbbb2222"]);
    assert.equal(entries[0]?.text, CHECK_OUTPUT);
    assert.ok(!logs.join("").includes("你好"), "应用日志不得含正文");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("message_check：日志写失败有限重试后仍返回消息并上报", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-"));
  try {
    const cli = await makeFakeCli(dir, { status: 0, stdout: CHECK_OUTPUT });
    let calls = 0;
    const failingLog: InboxLogPort = {
      append: async () => {
        calls += 1;
        throw new Error("disk full");
      },
      list: async () => [],
      purge: async () => 0,
      removeAll: async () => {},
    };
    const failures: string[] = [];
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: failingLog,
      failureSink: { onInboxLogWriteFailed: (_id, reason) => failures.push(reason) },
      sleep: async () => {},
    });
    const result = await adapter.invoke({ tool: "message_check" });
    assert.equal(calls, 3);
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.journalFailed, true);
    assert.equal(result.kind === "ok" && result.text, CHECK_OUTPUT);
    assert.deepEqual(failures, ["disk full"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("message_check：空收件箱不写空日志", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-"));
  try {
    const cli = await makeFakeCli(dir, { status: 0, stdout: "No more new inbox messages.\n" });
    const store = createInboxLogStore(dir);
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, cli.script),
      inboxLog: store,
    });
    assert.equal((await adapter.invoke({ tool: "message_check" })).kind, "ok");
    assert.deepEqual(await store.list("11111111-2222-3333-4444-555555555555"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("message_send：被扣成草稿时原样交还模型；正文经 stdin；超时为 unknown 不重发", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-"));
  try {
    const held = await makeFakeCli(dir, {
      status: 1,
      stdout: "新消息 A",
      stderr: "Error: held\nCode: SEND_HELD_AS_DRAFT\n",
    });
    const adapter = createCliToolAdapter({
      identity: identityFor(dir, held.script),
      inboxLog: createInboxLogStore(dir),
    });
    const result = await adapter.invoke({
      tool: "message_send",
      target: "#dev",
      content: "回复正文",
    });
    assert.equal(result.kind, "held");
    assert.ok(result.kind === "held" && result.text.includes("新消息 A"));
    const record = await held.readRecord();
    assert.equal(record.stdin, "回复正文");
    assert.ok(!record.argv.includes("--send-draft"), "适配器不得自动 --send-draft");

    const unknown = await makeFakeCli(dir, { status: 1, stderr: "Code: CANNOT_CONFIRM\n" });
    const adapter2 = createCliToolAdapter({
      identity: identityFor(dir, unknown.script),
      inboxLog: createInboxLogStore(dir),
    });
    assert.equal(
      (await adapter2.invoke({ tool: "message_send", target: "#dev", content: "x" })).kind,
      "unknown",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("收件日志存储：0700 目录、按保留期清理、拒绝非法 bindingId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-tools-"));
  try {
    let now = Date.UTC(2026, 8, 1);
    const store = createInboxLogStore(dir, () => now);
    const id = "abc-123";
    const entry = {
      receivedAt: "t",
      source: "message_check" as const,
      messageIds: ["m1"],
      targets: ["#dev"],
      text: "正文",
    };
    await store.append(id, entry);
    now += 15 * 86_400_000;
    await store.append(id, { ...entry, messageIds: ["m2"] });
    const removed = await store.purge(id, { olderThanMs: 14 * 86_400_000 });
    assert.equal(removed, 1);
    assert.deepEqual(
      (await store.list(id)).map((e) => e.messageIds[0]),
      ["m2"],
    );
    const files = await readdir(join(dir, "raft", "inbox-logs", id));
    assert.equal(files.length, 1);
    await assert.rejects(() => store.append("../evil", entry));
    await store.removeAll(id);
    assert.deepEqual(await store.list(id), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("保留期：默认 14 天，上限 30 天", () => {
  assert.equal(clampInboxLogRetentionDays(undefined), 14);
  assert.equal(clampInboxLogRetentionDays(0), 14);
  assert.equal(clampInboxLogRetentionDays(90), 30);
  assert.equal(clampInboxLogRetentionDays(7), 7);
});
