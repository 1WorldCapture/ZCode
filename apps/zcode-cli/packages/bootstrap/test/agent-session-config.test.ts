// R5 / task #23：Agent 会话级配置持久化模块的单元测试。
// 关键不变量：
// 1. 白名单提取——只挑五个配置字段，params 里任何其他字段（尤其凭据形态）不进快照；
// 2. entry id 按 session 作用域——session_entry.id 是全库主键，固定字面量会让
//    第二个 Agent 会话 upsert 改绑第一个会话的配置；
// 3. 读取形状守卫——坏数据退化为 undefined，不把损坏 JSON 当有效配置；
// 4. 持久化失败只告警不阻断（冷恢复退化为既有行为）。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntryInfo } from "@zcode/contracts";

import {
  agentSessionConfigOf,
  persistAgentSessionConfigEntry,
  readAgentSessionConfig,
  type AgentSessionConfigStoreHost,
} from "../src/zcode-protocol/agent-session-config.js";
import type { ZCodeSessionRecordParams } from "../src/zcode-protocol/server-operations.js";

/** 内存 fake store：按 id upsert（复刻 sqlite session_entry 的主键语义）。 */
function fakeStore() {
  const entries = new Map<string, SessionEntryInfo>();
  const calls: Array<{ touchSession?: boolean }> = [];
  return {
    entries,
    calls,
    host(overrides: Partial<AgentSessionConfigStoreHost["deps"]["sessionStore"]> = {}): AgentSessionConfigStoreHost {
      return {
        deps: {
          sessionStore: {
            async saveSessionEntry(input) {
              calls.push({ touchSession: input.touchSession });
              entries.set(input.id, input);
            },
            async sessionEntries(input) {
              return [...entries.values()].filter(
                (entry) =>
                  String(entry.sessionID) === String(input.sessionID) &&
                  (input.type === undefined || entry.type === input.type),
              );
            },
            ...overrides,
          },
        },
      };
    },
  };
}

const FULL_PARAMS = {
  sessionId: "s-1",
  agentMemory: { homeRoot: "/data/agents/b1/workspace", agentName: "Dev-developer" },
  officialMcpServers: [
    { name: "raft-agent-tools", env: [{ name: "ZCODE_RAFT_BINDING_ID", value: "b1" }] },
  ],
  toolAllowlist: undefined,
  toolDenylist: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
  confineFileToolsToWorkspace: true,
} as unknown as ZCodeSessionRecordParams;

test("提取：白名单五字段；普通会话（全空）返回 undefined", () => {
  const snapshot = agentSessionConfigOf(FULL_PARAMS);
  assert.ok(snapshot);
  assert.equal(snapshot.agentMemory?.homeRoot, "/data/agents/b1/workspace");
  assert.equal(snapshot.officialMcpServers?.[0]?.name, "raft-agent-tools");
  assert.equal(snapshot.toolDenylist?.length, 3);
  assert.equal(snapshot.confineFileToolsToWorkspace, true);

  // 普通会话：一项都没有 → undefined（不落 entry、不改变既有行为）。
  assert.equal(agentSessionConfigOf({ sessionId: "s-2" } as ZCodeSessionRecordParams), undefined);
});

test("提取：凭据形态绝不进快照（安全不变量）", () => {
  // 即使上游形状意外多出凭据字段，白名单提取也只认五个配置字段。
  const tainted = {
    ...FULL_PARAMS,
    token: "sk_agent_supersecret",
    profileCredential: "sk_agent_another",
  } as unknown as ZCodeSessionRecordParams;
  const snapshot = agentSessionConfigOf(tainted);
  assert.ok(snapshot);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("sk_agent_"), `snapshot must not contain credential shapes: ${serialized}`);
  assert.equal("token" in snapshot, false);
});

test("提取：confineFileToolsToWorkspace=false（falsy 但显式）必须保留", () => {
  const snapshot = agentSessionConfigOf({
    sessionId: "s-3",
    confineFileToolsToWorkspace: false,
  } as unknown as ZCodeSessionRecordParams);
  assert.ok(snapshot);
  assert.equal(snapshot.confineFileToolsToWorkspace, false);
  assert.equal(snapshot.agentMemory, undefined);
});

test("持久化：entry 形状（type/id 作用域/touchSession=false）且不含 sk_agent_", async () => {
  const store = fakeStore();
  const snapshot = agentSessionConfigOf(FULL_PARAMS);
  assert.ok(snapshot);
  await persistAgentSessionConfigEntry(store.host(), "sess-aaa", snapshot);

  assert.equal(store.entries.size, 1);
  const entry = store.entries.get("agent_session_config:sess-aaa");
  assert.ok(entry);
  assert.equal(entry.type, "runtime/agent_session_config");
  assert.equal(entry.sessionID, "sess-aaa");
  assert.equal(entry.touchSession, false);
  assert.ok(!("token" in (entry.data as Record<string, unknown>)));
  const serialized = JSON.stringify(entry.data);
  assert.ok(!serialized.includes("sk_agent_"), `persisted entry must not contain credential shapes: ${serialized}`);
});

test("持久化：id 按 session 作用域，两个会话互不覆盖（全库主键语义）", async () => {
  const store = fakeStore();
  const a = agentSessionConfigOf(FULL_PARAMS);
  const b = agentSessionConfigOf({
    ...FULL_PARAMS,
    agentMemory: { homeRoot: "/data/agents/b2/workspace" },
    toolDenylist: ["AskUserQuestion"],
  } as unknown as ZCodeSessionRecordParams);
  assert.ok(a && b);
  await persistAgentSessionConfigEntry(store.host(), "sess-a", a);
  await persistAgentSessionConfigEntry(store.host(), "sess-b", b);
  assert.equal(store.entries.size, 2);

  const readA = await readAgentSessionConfig(store.host(), "sess-a");
  const readB = await readAgentSessionConfig(store.host(), "sess-b");
  assert.equal(readA?.agentMemory?.homeRoot, "/data/agents/b1/workspace");
  assert.equal(readA?.toolDenylist?.length, 3);
  assert.equal(readB?.agentMemory?.homeRoot, "/data/agents/b2/workspace");
  assert.equal(readB?.toolDenylist?.length, 1);
});

test("读取：往返一致（含 falsy 布尔与 allowlist 缺席）", async () => {
  const store = fakeStore();
  const snapshot = agentSessionConfigOf(FULL_PARAMS);
  assert.ok(snapshot);
  await persistAgentSessionConfigEntry(store.host(), "sess-rt", snapshot);
  const restored = await readAgentSessionConfig(store.host(), "sess-rt");
  assert.deepEqual(restored, snapshot);
});

test("读取：坏形状逐字段丢弃，好字段保留", async () => {
  const store = fakeStore();
  const entry: SessionEntryInfo = {
    id: "agent_session_config:sess-bad",
    sessionID: "sess-bad" as never,
    type: "runtime/agent_session_config",
    time: { created: 1, updated: 1 },
    data: {
      agentMemory: { homeRoot: 42 }, // 坏：homeRoot 非字符串
      officialMcpServers: [{ name: "raft-agent-tools", env: "not-an-array" }], // 坏：env 非数组
      toolDenylist: ["AskUserQuestion", 7], // 坏：非纯字符串数组
      confineFileToolsToWorkspace: "yes", // 坏：非布尔
      toolAllowlist: ["Read", "Write"], // 好
    },
  };
  store.entries.set(entry.id, entry);
  const restored = await readAgentSessionConfig(store.host(), "sess-bad");
  assert.deepEqual(restored, { toolAllowlist: ["Read", "Write"] });
});

test("读取：缺失 entry / 宿主无 sessionEntries / 读取抛错 都返回 undefined", async () => {
  const store = fakeStore();
  assert.equal(await readAgentSessionConfig(store.host(), "sess-none"), undefined);
  assert.equal(await readAgentSessionConfig({ deps: {} }, "sess-1"), undefined);
  assert.equal(
    await readAgentSessionConfig(
      store.host({
        sessionEntries: async () => {
          throw new Error("store unavailable");
        },
      }),
      "sess-1",
    ),
    undefined,
  );
});

test("持久化：宿主不支持 saveSessionEntry 时 no-op；写入抛错只告警不拒绝", async () => {
  const warnings: string[] = [];
  const host: AgentSessionConfigStoreHost = {
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
    deps: {
      sessionStore: {
        saveSessionEntry: async () => {
          throw new Error("FK violation");
        },
      },
    },
  };
  // 不 reject——持久化失败不能阻断会话创建/恢复。
  await persistAgentSessionConfigEntry(host, "sess-x", { toolDenylist: ["AskUserQuestion"] });
  assert.equal(warnings.length, 1);
  // 宿主缺省能力：静默 no-op。
  await persistAgentSessionConfigEntry({ deps: {} }, "sess-x", { toolDenylist: ["AskUserQuestion"] });
});
