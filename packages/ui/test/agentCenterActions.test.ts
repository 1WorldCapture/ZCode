import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  pauseAgent,
  refreshAgents,
  removeAgent,
  resetAgent,
  restartAgent,
  startAgent,
  submitConnect,
} from "../src/agents/agentCenterActions.js";
import { useAgentCenterStore } from "../src/agents/agentCenterStore.js";

const item = (bindingId: string) => ({
  bindingId,
  displayName: bindingId,
  raftOrigin: "https://raft.example",
  connectionState: "credential_ok" as const,
  runState: "ReadyStopped" as const,
  homePath: `/h/${bindingId}`,
});

const input = {
  raftOrigin: "https://raft.example",
  raftAgentId: "a".repeat(8),
  token: "sk_agent_secret",
  homeWorkspacePath: "",
};

function fakeService(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const service = {
    list: async () => {
      calls.push("list");
      return [item("b1")];
    },
    setDesiredState: async (id: string, desired: string) => {
      calls.push(`set:${id}:${desired}`);
    },
    createBinding: async () => ({ ok: false as const, code: "TokenInvalid" as const }),
    restartBinding: async () => ({ ok: true as const }),
    resetBinding: async () => ({ ok: true as const }),
    removeBinding: async () => {
      /* no-op */
    },
    ...overrides,
  };
  return { service: service as never, calls };
}

beforeEach(() => {
  useAgentCenterStore.setState({
    items: [],
    loaded: false,
    loadFailed: false,
    view: { page: "list" },
    submitting: false,
    submitError: null,
    actionFailed: false,
  });
});

test("refreshAgents：成功写入快照并标记已加载；失败只标记 loadFailed，不清空旧数据", async () => {
  const { service } = fakeService();
  await refreshAgents(service);
  assert.equal(useAgentCenterStore.getState().loaded, true);
  assert.deepEqual(
    useAgentCenterStore.getState().items.map((i) => i.bindingId),
    ["b1"],
  );

  const failing = fakeService({ list: async () => Promise.reject(new Error("rpc down")) }).service;
  await refreshAgents(failing);
  assert.equal(useAgentCenterStore.getState().loadFailed, true);
  assert.deepEqual(
    useAgentCenterStore.getState().items.map((i) => i.bindingId),
    ["b1"],
    "刷新失败不得清空已显示的数据",
  );
});

test("开始/暂停：调用 setDesiredState 后刷新；失败置 actionFailed 且仍刷新", async () => {
  const { service, calls } = fakeService();
  await startAgent(service, "b1");
  await pauseAgent(service, "b1");
  assert.deepEqual(calls, ["set:b1:Running", "list", "set:b1:ReadyStopped", "list"]);
  assert.equal(useAgentCenterStore.getState().actionFailed, false);

  const failing = fakeService({ setDesiredState: async () => Promise.reject(new Error("boom")) });
  await startAgent(failing.service, "b1");
  assert.equal(useAgentCenterStore.getState().actionFailed, true);
  assert.deepEqual(failing.calls, ["list"]);
});

test("submitConnect：失败返回错误码不回列表；成功刷新并回到列表；提交中重复点击被忽略", async () => {
  const { service } = fakeService();
  assert.equal(await submitConnect(service, input), false);
  assert.deepEqual(useAgentCenterStore.getState().submitError, {
    code: "TokenInvalid",
    detail: undefined,
  });
  assert.equal(useAgentCenterStore.getState().submitting, false);

  useAgentCenterStore.setState({ view: { page: "connect" } });
  const ok = fakeService({ createBinding: async () => ({ ok: true as const, binding: {} }) });
  assert.equal(await submitConnect(ok.service, input), true);
  assert.deepEqual(useAgentCenterStore.getState().view, { page: "list" });
  assert.equal(useAgentCenterStore.getState().items.length, 1);

  useAgentCenterStore.setState({ submitting: true });
  assert.equal(await submitConnect(service, input), false, "提交中不重复提交");
});

test("token 永不进入 store", async () => {
  const { service } = fakeService();
  await submitConnect(service, input);
  assert.ok(!JSON.stringify(useAgentCenterStore.getState()).includes("sk_agent_secret"));
});

test("复用凭据模式：existingProfileSlug 原样传给 createBinding，输入不带 token", async () => {
  let received: unknown = null;
  const reuseInput = {
    raftOrigin: "https://raft.example",
    raftAgentId: "a".repeat(8),
    existingProfileSlug: "slug-1",
  };
  const ok = fakeService({
    createBinding: async (inputArg: unknown) => {
      received = inputArg;
      return { ok: true as const, binding: {} };
    },
  });
  assert.equal(await submitConnect(ok.service, reuseInput as never), true);
  assert.deepEqual(received, reuseInput);
  assert.ok(
    !JSON.stringify(useAgentCenterStore.getState()).includes("token"),
    "复用模式全程不接触 token",
  );
});

test("管理动作：重启/重置成功刷新；失败置 actionFailed；删除固定 deleteHome:true", async () => {
  const { service, calls } = fakeService();
  assert.equal(await restartAgent(service, "b1"), true);
  assert.equal(await resetAgent(service, "b1"), true);
  assert.deepEqual(calls, ["list", "list"]);
  assert.equal(useAgentCenterStore.getState().actionFailed, false);

  const failing = fakeService({
    restartBinding: async () => ({ ok: false as const, code: "SessionCreateFailed" as const }),
    resetBinding: async () => Promise.reject(new Error("boom")),
  });
  assert.equal(await restartAgent(failing.service, "b1"), false);
  assert.equal(await resetAgent(failing.service, "b1"), false);
  assert.equal(useAgentCenterStore.getState().actionFailed, true);

  let removeArgs: unknown = null;
  const removable = fakeService({
    removeBinding: async (bindingId: string, opts: unknown) => {
      removeArgs = { bindingId, opts };
    },
  });
  assert.equal(await removeAgent(removable.service, "b1"), true);
  assert.deepEqual(removeArgs, { bindingId: "b1", opts: { deleteHome: true } });
  assert.deepEqual(removable.calls, ["list"]);
});
