// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveProfileSlug,
  findBindingConflicts,
  homePathsConflict,
  normalizeHomePathForCompare,
  normalizeRaftOrigin,
} from "../src/raft-agents/domain/binding.js";
import {
  capKeepingTail,
  compareVersions,
  parseAgentName,
  parseCliErrorCode,
  parseCliVersion,
  sanitizedEnv,
} from "../src/raft-agents/adapters/raftCli.js";
import type { RaftAgentBinding } from "@zcode/shared";

const DARWIN = { win32: false };

test("normalizeRaftOrigin 规范化 host 与尾斜杠", () => {
  assert.equal(normalizeRaftOrigin("https://Raft.Example.com/"), "https://raft.example.com");
  assert.equal(normalizeRaftOrigin("raft.example.com"), "https://raft.example.com");
  assert.equal(normalizeRaftOrigin("https://raft.example.com/raft/"), "https://raft.example.com/raft");
  assert.equal(normalizeRaftOrigin("http://localhost:13072"), "http://localhost:13072");
});

test("normalizeRaftOrigin 拒绝非法输入", () => {
  assert.equal(normalizeRaftOrigin(""), undefined);
  assert.equal(normalizeRaftOrigin("   "), undefined);
  assert.equal(normalizeRaftOrigin("ftp://raft.example.com"), undefined);
  assert.equal(normalizeRaftOrigin("https://"), undefined);
});

test("normalizeHomePathForCompare 只接受绝对路径并去尾分隔符", () => {
  assert.equal(normalizeHomePathForCompare("/a/b/", DARWIN), "/a/b");
  assert.equal(normalizeHomePathForCompare("/a//b", DARWIN), "/a//b");
  assert.equal(normalizeHomePathForCompare("a/b", DARWIN), undefined);
  assert.equal(normalizeHomePathForCompare("", DARWIN), undefined);
});

test("normalizeHomePathForCompare win32 统一分隔符与大小写", () => {
  assert.equal(normalizeHomePathForCompare("C:\\Users\\a\\Home\\", { win32: true }), "c:/users/a/home");
});

test("homePathsConflict 父目录绕过被识别", () => {
  assert.equal(homePathsConflict("/a/home", "/a/home"), true);
  assert.equal(homePathsConflict("/a/home", "/a/home/workspace"), true);
  assert.equal(homePathsConflict("/a/home/workspace", "/a/home"), true);
  // 前缀相同但非路径边界不算冲突。
  assert.equal(homePathsConflict("/a/home-x", "/a/home"), false);
  assert.equal(homePathsConflict("/a/home", "/b/home"), false);
});

test("deriveProfileSlug 不含连字符且长度固定", () => {
  const slug = deriveProfileSlug("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(slug, "raft-aaaaaaaabbbb");
});

function makeBinding(overrides: Partial<RaftAgentBinding> = {}): RaftAgentBinding {
  return {
    bindingId: "11111111-2222-4333-8444-555555555555",
    displayName: "Existing",
    raftOrigin: "https://raft.example.com",
    serverId: "server-1",
    raftAgentId: "99999999-8888-4777-a666-555555555555",
    profileSlug: "raft-existing",
    homeWorkspacePath: "/data/agents/existing/workspace",
    mainSessionRef: null,
    desiredState: "ReadyStopped",
    autostartConsent: false,
    adapterInstance: "11111111-2222-4333-8444-555555555555",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

test("findBindingConflicts 路径前缀冲突", () => {
  const existing = [makeBinding()];
  const conflict = findBindingConflicts(
    {
      homePathForCompare: "/data/agents/existing", // 既有 Home 的父目录。
      profileSlug: "raft-new",
      raftOrigin: "https://other.example.com",
      serverId: "server-2",
      raftAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    existing,
    DARWIN,
  );
  assert.equal(conflict?.kind, "PathConflict");
  assert.equal(conflict?.conflictWith.displayName, "Existing");
});

test("findBindingConflicts 同身份重复接入被拒（AlreadyBound）", () => {
  const existing = [makeBinding()];
  const conflict = findBindingConflicts(
    {
      homePathForCompare: "/data/agents/other/workspace",
      profileSlug: "raft-new",
      raftOrigin: "https://raft.example.com",
      serverId: "server-1",
      raftAgentId: "99999999-8888-4777-a666-555555555555",
    },
    existing,
    DARWIN,
  );
  assert.equal(conflict?.kind, "AlreadyBound");
});

test("findBindingConflicts 不同身份不同路径放行", () => {
  const existing = [makeBinding()];
  const conflict = findBindingConflicts(
    {
      homePathForCompare: "/data/agents/other/workspace",
      profileSlug: "raft-new",
      raftOrigin: "https://raft.example.com",
      serverId: "server-1",
      raftAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    existing,
    DARWIN,
  );
  assert.equal(conflict, undefined);
});

test("parseCliVersion/parseCliErrorCode/parseAgentName 按 CLI 契约解析", () => {
  assert.equal(parseCliVersion("Raft CLI: 0.0.24\n"), "0.0.24");
  assert.equal(parseCliVersion("something else"), undefined);
  // fork 后缀（A3 发布 0.0.24-zcode.1）：取前三段，满足最低版本比较。
  assert.equal(parseCliVersion("Raft CLI: 0.0.24-zcode.1\n"), "0.0.24");
  assert.equal(parseCliVersion("Raft CLI: 1.2.3-rc.4"), "1.2.3");
  assert.equal(parseCliVersion("Raft CLI: 0.0.24-zcode.1.2.3-extra"), undefined);
  assert.equal(parseCliErrorCode("Error: The server did not accept the token.\nCode: INVALID_AGENT_TOKEN\n"), "INVALID_AGENT_TOKEN");
  assert.equal(
    parseAgentName("state: authorized\nLogged in as 'Alice Agent' on https://raft.example. Credential saved to /p.\n"),
    "Alice Agent",
  );
});

test("compareVersions 语义化比较", () => {
  assert.equal(compareVersions("0.0.24", "0.0.24"), 0);
  assert.equal(compareVersions("0.0.23", "0.0.24"), -1);
  assert.equal(compareVersions("0.1.0", "0.0.24"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("sanitizedEnv：POSIX 白名单不含托管注入变量，代理/CA 变量透传", () => {
  const env = sanitizedEnv(
    { RAFT_PROFILE_DIR: "/data/raft/profiles/p1" },
    {
      platform: "darwin",
      source: {
        HOME: "/Users/a",
        PATH: "/usr/bin",
        TMPDIR: "/tmp",
        LANG: "zh_CN.UTF-8",
        HTTPS_PROXY: "http://proxy.corp:8080",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/certscorp.pem",
        // 全部应被剥离。
        SLOCK_DAEMON: "1",
        RAFT_CHANNEL_TOKEN: "sk_agent_should_not_pass",
        SECRET_ENV: "x",
      },
    },
  );
  assert.equal(env.HOME, "/Users/a");
  assert.equal(env.HTTPS_PROXY, "http://proxy.corp:8080");
  assert.equal(env.no_proxy, "localhost");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/certscorp.pem");
  assert.equal(env.RAFT_PROFILE_DIR, "/data/raft/profiles/p1");
  assert.equal("SLOCK_DAEMON" in env, false);
  assert.equal("RAFT_CHANNEL_TOKEN" in env, false);
  assert.equal("SECRET_ENV" in env, false);
});

test("sanitizedEnv：win32 追加系统必需变量", () => {
  const env = sanitizedEnv(
    {},
    {
      platform: "win32",
      source: {
        PATH: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\a",
        APPDATA: "C:\\Users\\a\\AppData\\Roaming",
        PATHEXT: ".COM;.EXE",
        HOME: "/should/not/matter/but/harmless",
      },
    },
  );
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.USERPROFILE, "C:\\Users\\a");
  assert.equal(env.PATHEXT, ".COM;.EXE");
  // darwin 分支不收的 win32 变量在 darwin 下剥离。
  const darwinEnv = sanitizedEnv({}, { platform: "darwin", source: { SystemRoot: "C:\\Windows" } });
  assert.equal("SystemRoot" in darwinEnv, false);
});

test("capKeepingTail 保尾部且守 UTF-8 边界", () => {
  assert.equal(capKeepingTail("short", 100), "short");
  const long = `${"x".repeat(5000)}TAIL_CODE_LINE`;
  const capped = capKeepingTail(long, 20);
  assert.ok(capped.endsWith("TAIL_CODE_LINE"));
  assert.ok(Buffer.byteLength(capped, "utf8") <= 20);
  // 多字节字符不被截半：截断点向后退到整字符边界。
  const mb = "中".repeat(100);
  const cappedMb = capKeepingTail(mb, 10);
  assert.ok(Buffer.byteLength(cappedMb, "utf8") <= 10);
  assert.ok(cappedMb.endsWith("中"));
});
