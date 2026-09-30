/**
 * 官方 raft CLI 子进程执行器（本包自带，不依赖 @zcode/services）。
 *
 * 环境净化（T0 实测硬约束）：CLI 检测到托管运行时注入的 SLOCK_/RAFT_ 前缀变量
 * 会拒绝 --profile（PROFILE_MANAGED_CONTEXT_CONFLICT）。因此子进程环境白名单构造，
 * 不继承宿主 env。
 */
import { spawn } from "node:child_process";

export interface CliRun {
  /** null 表示被杀（超时）或未拿到退出码。 */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 单路输出上限：保护本机内存，超出部分丢弃。 */
const MAX_OUTPUT_CHARS = 1_000_000;

// 各平台让 Node/CLI 正常运行所需的最小变量集；不含任何 RAFT_/SLOCK_ 前缀变量。
const BASE_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"];
const WIN32_ENV_KEYS = ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "COMSPEC", "PATHEXT"];
// 网络出口相关：企业代理/自签证书环境下 CLI 才连得上 Raft 服务。
const NETWORK_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS"];

/** 白名单子进程环境：宿主的进程定位必需项 + 调用方显式设置的项。 */
export function sanitizedEnv(extra: Record<string, string>): Record<string, string> {
  const keys = [...BASE_ENV_KEYS, ...NETWORK_ENV_KEYS, ...(process.platform === "win32" ? WIN32_ENV_KEYS : [])];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function runCli(
  cliPath: string,
  args: string[],
  opts: { timeoutMs: number; env: Record<string, string>; stdin?: string },
): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      env: sanitizedEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    // 子进程不读 stdin 就退出时写入会触发 EPIPE，忽略即可（结果由退出码判断）。
    child.stdin.on("error", () => undefined);
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/** 解析 stderr 里的 `Code: <XXX>` 行（CLI 错误契约）。 */
export function parseCliErrorCode(stderr: string): string | undefined {
  const match = /^Code:\s*([A-Z0-9_]+)\s*$/m.exec(stderr);
  return match?.[1];
}
