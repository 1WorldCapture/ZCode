import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveProfileSlug,
  findBindingConflicts,
  homePathsConflict,
  normalizeHomePathForCompare,
  normalizeRaftOrigin,
} from "../src/raft-agents/domain/binding.js";
import { compareVersions, parseAgentName, parseCliErrorCode, parseCliVersion } from "../src/raft-agents/adapters/raftCli.js";
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

test("findBindingConflicts 同身份重复接入被拒", () => {
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
  assert.equal(conflict?.kind, "SlugConflict");
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
