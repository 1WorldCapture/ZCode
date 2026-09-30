import assert from "node:assert/strict";
import test from "node:test";
import { OfficialMcpHostUnavailableError, resolveRequestedOfficialMcpServers } from "../src/app/official-mcp-hosts.js";
import { OFFICIAL_RAFT_AGENT_TOOLS_PLUGIN_ID } from "../src/app/official-plugin-definitions.js";

const ROOT = "/stage/packages/raft-agent-tools";
const plugins = (over: Partial<{ enabled: boolean }> = {}) =>
  ({ plugins: [{ id: OFFICIAL_RAFT_AGENT_TOOLS_PLUGIN_ID, enabled: over.enabled ?? true, rootPath: ROOT }] }) as never;

const REF = {
  name: "raft-agent-tools" as const,
  env: { ZCODE_RAFT_BINDING_ID: "b1", ZCODE_RAFT_PROFILE_SLUG: "raft-x" },
};

test("解析：由 app-server 拼 stdio 配置，隔离与协议版本被锁定，环境变量合并", () => {
  const out = resolveRequestedOfficialMcpServers({ pluginOutcome: plugins(), requested: [REF], workingDirectory: "/home/agent" });
  const server = out.raft_agent_tools;
  assert.ok(server && server.type === "stdio");
  assert.equal(server.isolation, "session");
  assert.equal(server.protocolVersion, "2026-07-28");
  assert.ok(server.args?.some((arg) => arg.endsWith("dist/mcp/server.js")) && server.args?.some((arg) => arg.includes(ROOT)));
  assert.equal(server.env?.ZCODE_RAFT_BINDING_ID, "b1");
  assert.equal(server.env?.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(server.cwd, "/home/agent");
});

test("解析：未请求时返回空；环境变量键前缀白名单，越界拒绝", () => {
  assert.deepEqual(resolveRequestedOfficialMcpServers({ pluginOutcome: plugins(), requested: undefined, workingDirectory: "/w" }), {});
  assert.throws(
    () =>
      resolveRequestedOfficialMcpServers({
        pluginOutcome: plugins(),
        requested: [{ ...REF, env: { NODE_OPTIONS: "--require /tmp/evil.js" } }],
        workingDirectory: "/w",
      }),
    OfficialMcpHostUnavailableError,
  );
});

test("解析：插件缺失或未启用时 fail-closed 抛错，未知名字拒绝", () => {
  assert.throws(
    () => resolveRequestedOfficialMcpServers({ pluginOutcome: { plugins: [] } as never, requested: [REF], workingDirectory: "/w" }),
    OfficialMcpHostUnavailableError,
  );
  assert.throws(
    () => resolveRequestedOfficialMcpServers({ pluginOutcome: plugins({ enabled: false }), requested: [REF], workingDirectory: "/w" }),
    OfficialMcpHostUnavailableError,
  );
  assert.throws(
    () =>
      resolveRequestedOfficialMcpServers({
        pluginOutcome: plugins(),
        requested: [{ name: "node-repl-host" as never, env: {} }],
        workingDirectory: "/w",
      }),
    OfficialMcpHostUnavailableError,
  );
});
