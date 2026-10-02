// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 官方 raft CLI 子进程的共享 Node 原语：环境净化、输出截断、命令运行、错误码解析。
 *
 * 唯一事实源：raft-agents 服务（登录/核验）与 raft-agent-tools 工具包（MCP 服务）共用，
 * 避免两侧环境白名单漂移。只依赖 node 内置模块；单独子路径导出，避免把 `./node` 整棵拖进 bundle。
 *
 * 环境净化（T0 实测硬约束）：CLI 检测到托管运行时注入的 SLOCK_ / RAFT_ 前缀变量
 * 会拒绝 --profile（PROFILE_MANAGED_CONTEXT_CONFLICT），所以子进程环境必须白名单构造，不继承宿主 env。
 */
import { spawn } from "node:child_process";

/** 子进程输出捕获上限（超出保留尾部——错误 Code 行在 stderr 末尾）。 */
const MAX_STDOUT_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 256_000;

/** 输出截断：保尾部（错误信息在尾部），按字节截取后对齐到 UTF-8 字符起始边界。 */
export function capKeepingTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  // 跳过续字节（10xxxxxx），从完整字符开始，避免开头出现半个多字节字符。
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 白名单子进程环境：仅宿主的进程定位必需项 + 我们显式设置的项。
 * 不含任何凭据形态；代理与 CA 变量是为企业内网可达性（不透传则 CLI 连不上内网 Raft）。
 * 代理/证书变量同时收大小写两种形态（类 Unix 上 env 键区分大小写，curl 习惯用小写）。
 */
const POSIX_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;
// win32：Node 的网络/crypto 需要 SystemRoot；TEMP/TMP 是默认临时目录；
// USERPROFILE/HOMEDRIVE/HOMEPATH/APPDATA/LOCALAPPDATA/PROGRAMDATA 是用户级路径解析；
// COMSPEC/PATHEXT 影响 spawn 与可执行查找。缺 SystemRoot 时 Node 子进程可能直接起不来。
const WIN32_ENV_KEYS = [
  ...POSIX_ENV_KEYS,
  "SystemRoot",
  "windir",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "COMSPEC",
  "PATHEXT",
] as const;

export function sanitizedEnv(
  extra: Record<string, string>,
  opts: { platform?: NodeJS.Platform; source?: Record<string, string | undefined> } = {},
): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  const source = opts.source ?? process.env;
  const keys = platform === "win32" ? WIN32_ENV_KEYS : POSIX_ENV_KEYS;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function runCli(
  cliPath: string,
  args: string[],
  opts: {
    timeoutMs: number;
    env: Record<string, string>;
    stdin?: string;
    /**
     * stdout 出现该权威成功行即视为命令已完成：结束子进程并按成功（status 0）返回。
     * 原因：官方 CLI 以 process.exitCode 结束而不是 process.exit，事件循环里残留的
     * 句柄（keep-alive 连接、定时器等）会让已成功的命令迟迟不退出，拖到超时被杀，
     * 调用方就会把"已成功"误判为"结果不确定"。
     */
    settleWhenStdoutMatches?: RegExp;
  },
): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      env: sanitizedEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settledBySuccessLine = false;
    const timer = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capKeepingTail(stdout + chunk.toString("utf8"), MAX_STDOUT_BYTES);
      if (!settledBySuccessLine && opts.settleWhenStdoutMatches?.test(stdout)) {
        settledBySuccessLine = true;
        // 给同一批输出的其余部分一点时间写完，再结束残留的子进程。
        setTimeout(() => child.kill(), 300);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capKeepingTail(stderr + chunk.toString("utf8"), MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        status: null,
        stdout,
        stderr: capKeepingTail(`${stderr}${String(error)}`, MAX_STDERR_BYTES),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: settledBySuccessLine ? 0 : code, stdout, stderr });
    });
    // 子进程不读 stdin 就退出时写入会触发 EPIPE，忽略即可（结果由退出码判断）。
    child.stdin.on("error", () => undefined);
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** 解析 stderr 里的 `Code: <XXX>` 行（CLI 错误契约）。 */
export function parseCliErrorCode(stderr: string): string | undefined {
  const match = /^Code:\s*([A-Z0-9_]+)\s*$/m.exec(stderr);
  return match?.[1];
}
