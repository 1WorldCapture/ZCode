// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 官方 raft CLI 子进程适配器。
 *
 * 环境净化（T0 实测硬约束，spec §4）：CLI 检测到托管运行时注入的
 * SLOCK_ 与 RAFT_ 前缀变量会拒绝 --profile（PROFILE_MANAGED_CONTEXT_CONFLICT）。
 * ZCode 宿主进程携带这些变量，因此子进程环境必须白名单构造，
 * 不继承宿主 env。
 *
 * 已对 raft-source f7682db / CLI 0.0.24 核实的契约：
 * - `raft --version` → `Raft CLI: <semver>`；最低 0.0.24；入口须为 dist/index.js。
 * - `raft agent login --server --agent --profile-slug --profile-dir`，token 走 stdin
 *   单行；CLI 自带 token 验证与 agentId 一致性校验（AGENT_IDENTITY_MISMATCH）。
 * - `raft auth whoami` 恒 JSON 输出，token 不回显。
 * - 失败形态：非零退出 + stderr `Code: <CODE>` 行。
 */
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { isResolvedPathWithin } from "@zcode/shared/node";

import { resolveCommandOnPath } from "#src/runtime-tools/runtimeToolResolver.js";

import {
  capKeepingTail,
  parseCliErrorCode,
  runCli,
  sanitizedEnv,
} from "@zcode/shared/node/cli-process";

import {
  MINIMUM_RAFT_CLI_VERSION,
  type RaftCliLoginOutcome,
  type RaftCliPort,
  type RaftCliResolution,
  type RaftCliWhoami,
} from "../app/ports.js";

// 环境净化 / 输出截断 / 命令运行 / 错误码解析的唯一事实源在 @zcode/shared；此处再导出以保持既有导入路径。
export { capKeepingTail, parseCliErrorCode, sanitizedEnv };

/** 开发/测试用的显式 CLI 路径覆盖。 */
const CLI_PATH_ENV = "ZCODE_RAFT_CLI";

const LOGIN_TIMEOUT_MS = 45_000;
const WHOAMI_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 8_000;

/** 子进程环境：宿主注入的代理/自定义 CA + 业务变量（设置页配置；读失败按无代理继续）。
 * 业务变量最后写（与 bridgeSupervisor 同序）：代理面永不覆盖业务键。 */
async function cliEnv(
  resolveProxyEnv: (() => Promise<Record<string, string>>) | undefined,
  extra: Record<string, string>,
): Promise<Record<string, string>> {
  try {
    return { ...(await resolveProxyEnv?.()), ...extra };
  } catch {
    return extra;
  }
}

/**
 * `Raft CLI: 0.0.24` → [0,0,24]；解析失败返回 undefined。
 * 允许 fork 后缀（`0.0.24-zcode.1`）：版本号取前三段比较，后缀只标识发布渠道
 *（A3 fork 构建 0.0.24-zcode.1 按 0.0.24 满足最低版本，线程 59b3e306）。
 */
export function parseCliVersion(stdout: string): string | undefined {
  const match = /^Raft CLI:\s*(\d+\.\d+\.\d+)(?:-[A-Za-z0-9][A-Za-z0-9.]*)?\s*$/m.exec(stdout);
  return match?.[1];
}

/** 语义化版本比较：a < b 返回 -1，相等 0，a > b 返回 1。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/** 登录成功输出里的 grep-stable 文案：`Logged in as '<name>' on <server>`。 */
export function parseAgentName(stdout: string): string | undefined {
  const match = /^Logged in as '(.+)' on \S+/m.exec(stdout);
  return match?.[1];
}

/** 登录失败的 CLI Code → 表单错误码映射。 */
function classifyLoginFailure(stderr: string): RaftCliLoginOutcome {
  const code = parseCliErrorCode(stderr);
  if (code === "INVALID_AGENT_TOKEN" || code === "AGENT_TOKEN_REQUIRED") {
    return { ok: false, code: "TokenInvalid" };
  }
  if (code === "AGENT_IDENTITY_MISMATCH") {
    return { ok: false, code: "IdentityMismatch" };
  }
  return { ok: false, code: "CredentialCheckFailed", detail: code };
}

/** CLI 路径解析：显式覆盖优先，其次 PATH 查找（复用 runtime-tools 的实现）。 */
function resolveCliPath(): string | undefined {
  const explicit = process.env[CLI_PATH_ENV];
  if (explicit && explicit.length > 0) return explicit;
  return resolveCommandOnPath("raft") ?? undefined;
}

export function createRaftCliAdapter(
  options: { resolveProxyEnv?: () => Promise<Record<string, string>> } = {},
): RaftCliPort {
  return {
    async resolve(): Promise<RaftCliResolution> {
      const cliPath = resolveCliPath();
      if (cliPath === undefined) {
        return { ok: false, code: "CliMissing" };
      }
      const run = await runCli(cliPath, ["--version"], {
        timeoutMs: VERSION_TIMEOUT_MS,
        env: await cliEnv(options.resolveProxyEnv, {}),
      });
      if (run.status !== 0) {
        return { ok: false, code: "CliMissing", detail: `exit ${run.status}` };
      }
      const version = parseCliVersion(run.stdout);
      if (version === undefined) {
        return { ok: false, code: "CliVersionUnsupported", detail: run.stdout.trim().slice(0, 80) };
      }
      if (compareVersions(version, MINIMUM_RAFT_CLI_VERSION) < 0) {
        return { ok: false, code: "CliVersionUnsupported", detail: version };
      }
      return { ok: true, cliPath, version };
    },

    async login(params): Promise<RaftCliLoginOutcome> {
      const cliPath = resolveCliPath();
      if (cliPath === undefined)
        return { ok: false, code: "CredentialCheckFailed", detail: "CliMissing" };
      const run = await runCli(
        cliPath,
        [
          "agent",
          "login",
          "--server",
          params.origin,
          "--agent",
          params.expectedAgentId,
          "--profile-slug",
          params.profileSlug,
          "--profile-dir",
          params.profileDir,
        ],
        {
          timeoutMs: LOGIN_TIMEOUT_MS,
          env: await cliEnv(options.resolveProxyEnv, { RAFT_PROFILE_DIR: params.profileDir }),
          // token 只经 stdin 单行；绝不进 argv / 日志 / 返回值。
          stdin: `${params.token}\n`,
        },
      );
      if (run.status === 0) {
        return { ok: true, agentName: parseAgentName(run.stdout) };
      }
      return classifyLoginFailure(run.stderr);
    },

    async whoami(params): Promise<RaftCliWhoami | { error: string }> {
      const cliPath = resolveCliPath();
      if (cliPath === undefined) return { error: "CliMissing" };
      const run = await runCli(cliPath, ["--profile", params.profileSlug, "auth", "whoami"], {
        timeoutMs: WHOAMI_TIMEOUT_MS,
        env: await cliEnv(options.resolveProxyEnv, { RAFT_PROFILE_DIR: params.profileDir }),
      });
      if (run.status !== 0) {
        return { error: parseCliErrorCode(run.stderr) ?? `exit ${run.status}` };
      }
      try {
        const parsed = JSON.parse(run.stdout) as { ok?: boolean; data?: Partial<RaftCliWhoami> };
        const data = parsed.data;
        if (parsed.ok === true && data?.agentId && data.serverUrl && data.serverId) {
          return { agentId: data.agentId, serverUrl: data.serverUrl, serverId: data.serverId };
        }
      } catch {
        // 落到统一错误返回。
      }
      return { error: "whoami_unexpected_output" };
    },

    async destroyProfile(params): Promise<void> {
      // 包含性防护（共享判定，审核 #8）：只删 profilesRoot 直系之内的目录；resolve 后
      // 按绝对路径前缀判包含，"..foo" 这类 resolve 后确实落在根内的目录名不再误拒。
      const root = resolve(params.profilesRoot);
      const target = resolve(params.profileDir);
      // win32 跨盘符显式拒绝：盘符比较直白、不依赖 relative() 的实现细节。
      const drive = (p: string) => (/^[a-zA-Z]:/.exec(p)?.[0]?.toLowerCase() ?? "");
      const rootDrive = drive(root);
      const targetDrive = drive(target);
      if (rootDrive !== targetDrive) {
        throw new Error(`refusing to destroy profile on a different drive: ${targetDrive || "?"} vs ${rootDrive || "?"}`);
      }
      if (!isAbsolute(params.profileDir) || !isResolvedPathWithin(target, root)) {
        throw new Error(`refusing to destroy profile outside profiles root: ${relative(root, target)}`);
      }
      await rm(target, { recursive: true, force: true });
    },
  };
}
