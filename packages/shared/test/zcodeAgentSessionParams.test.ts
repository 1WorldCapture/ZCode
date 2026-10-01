import assert from "node:assert/strict";
import test from "node:test";
import {
  zcodeAgentMemorySchema,
  zcodeOfficialMcpServerRefSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
} from "../src/zcode-protocol/index.js";

const workspace = { workspaceKey: "k", workspacePath: "/home/agent" };

test("agentMemory：只接受 homeRoot 与可选 agentName，多余字段拒绝", () => {
  assert.ok(zcodeAgentMemorySchema.safeParse({ homeRoot: "/h", agentName: "Bot" }).success);
  assert.ok(zcodeAgentMemorySchema.safeParse({ homeRoot: "/h" }).success);
  assert.ok(!zcodeAgentMemorySchema.safeParse({ homeRoot: "" }).success);
  assert.ok(!zcodeAgentMemorySchema.safeParse({ homeRoot: "/h", extra: 1 }).success);
});

test("officialMcpServers：名字白名单，env 是 name/value 数组，不接受 command/isolation 等字段", () => {
  assert.ok(
    zcodeOfficialMcpServerRefSchema.safeParse({
      name: "raft-agent-tools",
      env: [{ name: "ZCODE_RAFT_BINDING_ID", value: "b" }],
    }).success,
  );
  assert.ok(
    !zcodeOfficialMcpServerRefSchema.safeParse({ name: "node-repl-host", env: [] }).success,
  );
  assert.ok(
    !zcodeOfficialMcpServerRefSchema.safeParse({ name: "raft-agent-tools", env: [], command: "sh" })
      .success,
  );
  assert.ok(
    !zcodeOfficialMcpServerRefSchema.safeParse({
      name: "raft-agent-tools",
      env: [],
      isolation: "workspace",
    }).success,
  );
});

test("create/resume 参数都携带 agentMemory 与 officialMcpServers（恢复路径不能丢）", () => {
  const extras = {
    agentMemory: { homeRoot: "/home/agent", agentName: "Bot" },
    officialMcpServers: [{ name: "raft-agent-tools" as const, env: [] }],
  };
  const created = zcodeSessionCreateParamsSchema.safeParse({ workspace, ...extras });
  assert.ok(created.success, JSON.stringify(created.error?.issues));
  const resumed = zcodeSessionResumeParamsSchema.safeParse({ sessionId: "s1", ...extras });
  assert.ok(resumed.success, JSON.stringify(resumed.error?.issues));
  // 缺省仍是普通项目记忆会话。
  assert.ok(zcodeSessionCreateParamsSchema.safeParse({ workspace }).success);
});
