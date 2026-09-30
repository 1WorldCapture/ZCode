import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRaftAgentsService } from "../src/raft-agents/app/raftAgentsService.js";
import { createRaftBindingStore } from "../src/raft-agents/adapters/bindingStore.js";
import type { ClockPort, RaftCliLoginOutcome, RaftCliPort, RaftCliWhoami } from "../src/raft-agents/app/ports.js";

const AGENT_ID = "99999999-8888-4777-a666-555555555555";

/** 可编程的 CLI 假件：按脚本回放结果，并记录调用参数（断言 token 不进 argv）。 */
function fakeCli(script: {
  resolve?: RaftCliPort["resolve"];
  login?: (params: Parameters<RaftCliPort["login"]>[0]) => Promise<RaftCliLoginOutcome>;
  whoami?: (params: { profileSlug: string; profileDir: string }) => Promise<RaftCliWhoami | { error: string }>;
}): RaftCliPort & { loginCalls: Array<Parameters<RaftCliPort["login"]>[0]>; destroyCalls: string[] } {
  const loginCalls: Array<Parameters<RaftCliPort["login"]>[0]> = [];
  const destroyCalls: string[] = [];
  return {
    loginCalls,
    destroyCalls,
    resolve: script.resolve ?? (async () => ({ ok: true, cliPath: "/fake/raft", version: "0.0.24" })),
    login: script.login
      ? async (params) => {
          loginCalls.push(params);
          return script.login!(params);
        }
      : async (params) => {
          loginCalls.push(params);
          return { ok: true, agentName: "Fake Agent" };
        },
    whoami:
      script.whoami ??
      (async () => ({
        agentId: AGENT_ID,
        serverUrl: "https://raft.example.com",
        serverId: "server-1",
      })),
    destroyProfile: async (params) => {
      destroyCalls.push(params.profileDir);
    },
  };
}

const fixedClock: ClockPort = { nowIso: () => "2026-09-30T00:00:00.000Z" };

async function makeService(cli: RaftCliPort, dataRoot: string) {
  return createRaftAgentsService({
    cli,
    store: createRaftBindingStore(dataRoot),
    clock: fixedClock,
    dataRootDir: dataRoot,
  });
}

test("createBinding 成功路径：登录+核验+持久化，ReadyStopped 且 token 只经参数传递", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({});
    const service = await makeService(cli, dataRoot);
    const result = await service.createBinding({
      raftOrigin: "https://Raft.Example.com/",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.binding.raftOrigin, "https://raft.example.com");
      assert.equal(result.binding.raftAgentId, AGENT_ID);
      assert.equal(result.binding.serverId, "server-1");
      assert.equal(result.binding.displayName, "Fake Agent");
      assert.equal(result.binding.desiredState, "ReadyStopped");
      assert.equal(result.binding.adapterInstance, result.binding.bindingId);
      // 默认 Home 路径从数据根派生。
      assert.equal(result.binding.homeWorkspacePath, join(dataRoot, "agents", result.binding.bindingId, "workspace"));
    }
    // token 只出现在 login 参数（将转 stdin），从未进持久化文件。
    const stored = await readFile(join(dataRoot, "raft", "bindings.json"), "utf8");
    assert.equal(stored.includes("sk_agent_"), false);
    // 列表投影。
    const items = await service.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].runState, "ReadyStopped");
    assert.equal(items[0].connectionState, "credential_ok");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("createBinding token 被拒：无持久化残留（验收场景 2）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({ login: async () => ({ ok: false, code: "TokenInvalid" }) });
    const service = await makeService(cli, dataRoot);
    const result = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_wrongtoken",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TokenInvalid");
    assert.equal(cli.loginCalls.length, 1);
    const items = await service.list();
    assert.equal(items.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("createBinding 身份不一致（whoami 复核失败）被拒", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({
      whoami: async () => ({
        agentId: "00000000-0000-0000-0000-000000000000",
        serverUrl: "https://raft.example.com",
        serverId: "server-1",
      }),
    });
    const service = await makeService(cli, dataRoot);
    const result = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    assert.deepEqual(result, { ok: false, code: "IdentityMismatch" });
    assert.equal((await service.list()).length, 0);
    // 登录已成功、后续失败：本次 profile 必须被清理（防孤儿凭据）。
    assert.equal(cli.destroyCalls.length, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("createBinding 路径前缀冲突被拒且不打网络（fail-closed 前置）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({});
    const service = await makeService(cli, dataRoot);
    const first = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
      homeWorkspacePath: "/data/agents/a/workspace",
    });
    assert.equal(first.ok, true);
    const second = await service.createBinding({
      raftOrigin: "https://other.example.com",
      raftAgentId: "11111111-2222-4333-8444-555555555555",
      token: "sk_agent_testtoken456",
      // 既有 Home 的父目录：前缀包含，必须拒绝。
      homeWorkspacePath: "/data/agents/a",
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, "PathConflict");
    // 冲突在登录前发现：第二次调用不应触达 login。
    assert.equal(cli.loginCalls.length, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("createBinding 同身份重复接入：AlreadyBound 快速路径，不再打登录", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({});
    const service = await makeService(cli, dataRoot);
    await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    const second = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.code, "AlreadyBound");
      assert.equal(second.detail, "Fake Agent");
    }
    // 快速路径在登录前拒绝：登录只发生过一次。
    assert.equal(cli.loginCalls.length, 1);
    assert.equal((await service.list()).length, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("并发同身份竞态：都过前置检查时，锁内复核拒绝后者并清理其 profile", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const slugToAgent = new Map<string, string>();
    const cli = fakeCli({
      login: async (params) => {
        await new Promise((r) => setTimeout(r, 10));
        slugToAgent.set(params.profileSlug, params.expectedAgentId);
        return { ok: true, agentName: "Fake Agent" };
      },
      whoami: async (params) => {
        const agentId = slugToAgent.get(params.profileSlug);
        if (!agentId) return { error: "no-login" };
        return { agentId, serverUrl: "https://raft.example.com", serverId: "server-1" };
      },
    });
    const service = await makeService(cli, dataRoot);
    const [a, b] = await Promise.all([
      service.createBinding({ raftOrigin: "https://raft.example.com", raftAgentId: AGENT_ID, token: "sk_agent_testtoken123" }),
      service.createBinding({ raftOrigin: "https://raft.example.com", raftAgentId: AGENT_ID, token: "sk_agent_testtoken123" }),
    ]);
    const outcomes = [a, b].sort((x, y) => (x.ok === y.ok ? 0 : x.ok ? -1 : 1));
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[1].ok, false);
    if (!outcomes[1].ok) assert.equal(outcomes[1].code, "AlreadyBound");
    assert.equal((await service.list()).length, 1);
    // 输家的 profile 被清理，赢家的保留。
    assert.equal(cli.destroyCalls.length, 1);
    assert.equal(cli.loginCalls.length, 2);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("并发不同身份：登录窗口期的并发写入不被覆盖（锁内重读）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const slugToAgent = new Map<string, string>();
    const cli = fakeCli({
      login: async (params) => {
        await new Promise((r) => setTimeout(r, 10));
        slugToAgent.set(params.profileSlug, params.expectedAgentId);
        return { ok: true, agentName: `Agent ${params.expectedAgentId.slice(0, 4)}` };
      },
      whoami: async (params) => {
        const agentId = slugToAgent.get(params.profileSlug);
        if (!agentId) return { error: "no-login" };
        return { agentId, serverUrl: "https://raft.example.com", serverId: "server-1" };
      },
    });
    const service = await makeService(cli, dataRoot);
    await Promise.all([
      service.createBinding({ raftOrigin: "https://raft.example.com", raftAgentId: AGENT_ID, token: "sk_agent_testtoken123" }),
      service.createBinding({
        raftOrigin: "https://raft.example.com",
        raftAgentId: "11111111-2222-4333-8444-555555555555",
        token: "sk_agent_testtoken456",
      }),
    ]);
    // 修复前：后写者用登录前读的快照整体覆盖，丢前一条。
    const items = await service.list();
    assert.equal(items.length, 2);
    assert.equal(cli.destroyCalls.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("removeBinding 一并清理本地 profile（凭据不留孤儿）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({});
    const service = await makeService(cli, dataRoot);
    const created = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    assert.ok(created.ok);
    const binding = created.ok ? created.binding : undefined;
    assert.ok(binding);
    await service.removeBinding(binding!.bindingId, { deleteHome: false });
    assert.equal((await service.list()).length, 0);
    assert.equal(cli.destroyCalls.length, 1);
    assert.match(cli.destroyCalls[0], /raft\/profiles\//);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("createBinding Agent ID 非法：前置拒绝，不触达 CLI（UUID 语义与绑定 schema 同源）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({});
    const service = await makeService(cli, dataRoot);
    // 变体位非法（末组以 5 开头）：宽松正则会放行、存储层才炸——必须前置拦截。
    const result = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: "99999999-8888-7777-6666-555555555555",
      token: "sk_agent_testtoken123",
    });
    assert.deepEqual(result, { ok: false, code: "AgentIdInvalid" });
    assert.equal(cli.loginCalls.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("createBinding CLI 版本不符明确报错（验收：不自动安装）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const cli = fakeCli({ resolve: async () => ({ ok: false, code: "CliVersionUnsupported", detail: "0.0.20" }) });
    const service = await makeService(cli, dataRoot);
    const result = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    assert.deepEqual(result, { ok: false, code: "CliVersionUnsupported", detail: "0.0.20" });
    assert.equal(cli.loginCalls.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("removeBinding 与 setDesiredState 更新存储并广播", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const service = await makeService(fakeCli({}), dataRoot);
    const created = await service.createBinding({
      raftOrigin: "https://raft.example.com",
      raftAgentId: AGENT_ID,
      token: "sk_agent_testtoken123",
    });
    assert.ok(created.ok);
    const bindingId = created.ok ? created.binding.bindingId : "";

    const events: number[] = [];
    service.onBindingsChanged(() => events.push(1));

    await service.setDesiredState(bindingId, "Running");
    const afterSet = await service.get(bindingId);
    assert.equal(afterSet?.desiredState, "Running");
    // T1 无运行时源：Running 意图投影为 Starting（等待 T2/T3）。
    assert.equal((await service.list())[0].runState, "Starting");

    await service.removeBinding(bindingId, { deleteHome: false });
    assert.equal((await service.list()).length, 0);
    assert.equal(events.length, 2);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("绑定存储损坏时按空集恢复（读加固）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "raft-agents-"));
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dataRoot, "raft"), { recursive: true });
    await writeFile(join(dataRoot, "raft", "bindings.json"), "{ not json", "utf8");
    const service = await makeService(fakeCli({}), dataRoot);
    assert.deepEqual(await service.list(), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
