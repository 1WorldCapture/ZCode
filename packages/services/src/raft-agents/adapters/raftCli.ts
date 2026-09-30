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
import { access, constants, rm } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

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
/** PATH 上的可执行文件查找（win32 走 PATHEXT）。 */
async function findOnPath(binary: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) return undefined;
  const isWindows = process.platform === "win32";
  const candidates = isWindows
    ? (process.env.PATHEXT || ".COM;.EXE;.CMD;.BAT")
        .split(";")
        .map((ext) => `${binary}${ext.toLowerCase()}`)
    : [binary];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        // 继续找下一个候选。
      }
    }
  }
  return undefined;
}

/** `Raft CLI: 0.0.24` → [0,0,24]；解析失败返回 undefined。 */
export function parseCliVersion(stdout: string): string | undefined {
  const match = /^Raft CLI:\s*(\d+\.\d+\.\d+)\s*$/m.exec(stdout);
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

/** CLI 路径解析：显式覆盖优先，其次 PATH 查找。 */
async function resolveCliPath(): Promise<string | undefined> {
  const explicit = process.env[CLI_PATH_ENV];
  if (explicit && explicit.length > 0) return explicit;
  return findOnPath("raft");
}

export function createRaftCliAdapter(): RaftCliPort {
  return {
    async resolve(): Promise<RaftCliResolution> {
      const cliPath = await resolveCliPath();
      if (cliPath === undefined) {
        return { ok: false, code: "CliMissing" };
      }
      const run = await runCli(cliPath, ["--version"], {
        timeoutMs: VERSION_TIMEOUT_MS,
        env: {},
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
      const cliPath = await resolveCliPath();
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
          env: { RAFT_PROFILE_DIR: params.profileDir },
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
      const cliPath = await resolveCliPath();
      if (cliPath === undefined) return { error: "CliMissing" };
      const run = await runCli(cliPath, ["--profile", params.profileSlug, "auth", "whoami"], {
        timeoutMs: WHOAMI_TIMEOUT_MS,
        env: { RAFT_PROFILE_DIR: params.profileDir },
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
      // 包含性防护：只删 profilesRoot 直系子目录，profileDir 必须是绝对路径且
      // relative 不越过根（".." 开头）也不等于根本身。防任意目录误删。
      const root = resolve(params.profilesRoot);
      const target = resolve(params.profileDir);
      const rel = relative(root, target);
      if (!isAbsolute(params.profileDir) || rel === "" || rel.startsWith("..")) {
        throw new Error(`refusing to destroy profile outside profiles root: ${rel}`);
      }
      await rm(target, { recursive: true, force: true });
    },
  };
}
