/**
 * stdio 入口（构建产物 dist/mcp/server.js 的源）。
 *
 * 启动环境由宿主注入（只含路径与标识，不含任何 token；Raft 凭据留在 profile 目录，
 * 由官方 CLI 自己读取）：
 *   ZCODE_RAFT_BINDING_ID   绑定 id（收件日志分目录键）
 *   ZCODE_RAFT_PROFILE_SLUG profile slug
 *   ZCODE_RAFT_PROFILE_DIR  profile 目录（单个 profile 目录，不是父目录）
 *   ZCODE_RAFT_DATA_ROOT    应用数据根（收件日志落在 <root>/raft/inbox-logs/）
 *   ZCODE_RAFT_CLI_PATH     官方 raft CLI 入口（宿主已校验版本）
 *   ZCODE_RAFT_INBOX_RETENTION_DAYS 可选，收件日志保留天数（受上限约束）
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createCliToolAdapter } from "./cliToolAdapter.js";
import { createInboxLogStore } from "./inboxLogStore.js";
import { clampInboxLogRetentionDays } from "./ports.js";
import { createRaftToolsServer } from "./server.js";

const DAY_MS = 86_400_000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function main(): Promise<void> {
  const bindingId = requireEnv("ZCODE_RAFT_BINDING_ID");
  const identity = {
    bindingId,
    cliPath: requireEnv("ZCODE_RAFT_CLI_PATH"),
    profileSlug: requireEnv("ZCODE_RAFT_PROFILE_SLUG"),
    profileDir: requireEnv("ZCODE_RAFT_PROFILE_DIR"),
  };
  const inboxLog = createInboxLogStore(requireEnv("ZCODE_RAFT_DATA_ROOT"));

  // 启动时清理一次过期日志；失败不影响服务（下次启动再清）。
  const retentionDays = clampInboxLogRetentionDays(Number(process.env.ZCODE_RAFT_INBOX_RETENTION_DAYS));
  await inboxLog.purge(bindingId, { olderThanMs: retentionDays * DAY_MS }).catch(() => 0);

  const adapter = createCliToolAdapter({
    identity,
    inboxLog,
    // 应用日志只记 messageId 与条数，绝不记正文；写到 stderr 由宿主收集。
    logger: {
      info: (message, fields) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
      warn: (message, fields) => process.stderr.write(`WARN ${message} ${JSON.stringify(fields ?? {})}\n`),
    },
    // 日志写失败：宿主通过 stderr 的约定标记感知并置 ErrorPaused(inbox_log_write_failed)。
    failureSink: {
      onInboxLogWriteFailed: (id, reason) =>
        process.stderr.write(`RAFT_INBOX_LOG_WRITE_FAILED ${JSON.stringify({ bindingId: id, reason })}\n`),
    },
  });

  // 两种 wire era 都要服务：宿主对 session 隔离的官方 MCP 连接实测发 2025-era
  // initialize（无 _meta envelope），legacy:"reject" 会让握手必然失败——工具声明
  // 来自 manifest，模型看得到工具但每次调用都悬挂（e2e S4 第四层根因）。
  // 身份隔离不依赖握手 era（来自注入的 env），放宽到默认双 era 是安全的。
  const handle = serveStdio(() => createRaftToolsServer(adapter));
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  // MCP SDK 的 stdio transport 不监听 stdin 结束；父进程退出后必须自行收尾，避免孤儿进程。
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // 输出管道关闭表示 MCP client 已不可达：直接收尾，不再写诊断。
  process.on("uncaughtException", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") return shutdown();
    process.stderr.write(`raft_agent_tools uncaughtException: ${error.stack ?? error.message}\n`);
  });
}

void main().catch((error) => {
  process.stderr.write(`raft_agent_tools failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
