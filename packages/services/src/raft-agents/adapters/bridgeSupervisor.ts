/**
 * Bridge 进程管理：每个绑定一个官方 `raft agent bridge` 子进程（T2，spec §8.1 / §9）。
 *
 * 不变量：
 * 1. 同一绑定同一时刻最多一个进程：进程内映射 + pid 锁文件（同机多个 ZCode 进程）。
 * 2. token 只经环境变量 RAFT_CHANNEL_TOKEN 传给子进程，不进 argv、不进日志、不进退出通知。
 * 3. 子进程环境净化（不继承 RAFT_/SLOCK_ 等身份变量）。
 * 4. 意外退出不自动重启：上报 BridgeExitInfo，由服务置 ErrorPaused(bridge_exit)。
 * 5. 只有主窗口承载：启动前必须通过 OwnerGuard。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTree,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminatorOptions,
} from "../../process/processTreeTerminator.js";
import type {
  BridgeBindingRef,
  BridgeExitInfo,
  BridgeStartResult,
  BridgeSupervisorPort,
  OwnerGuardPort,
  WakeEndpointPort,
} from "../app/bridgePorts.js";
import { createBridgeLock, type BridgeLockHandle } from "./bridgeLock.js";
import { sanitizedEnv } from "./raftCli.js";

const STDERR_TAIL_BYTES = 4_000;
/** 启动后多久没退出才算「拉起成功」；覆盖参数错误、身份不符等立即失败。 */
const DEFAULT_SETTLE_MS = 1_500;
// 必须小于 Host 关停 service-dispose 阶段的超时（3.5s），强杀才来得及在阶段超时前落地。
const DEFAULT_STOP_GRACE_MS = 2_000;

export interface BridgeSupervisorOptions {
  dataRootDir: string;
  wakeEndpoint: WakeEndpointPort;
  ownerGuard: OwnerGuardPort;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** 测试注入。 */
  spawn?: typeof nodeSpawn;
  settleMs?: number;
  stopGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

interface Running {
  child: ChildProcess;
  lock: BridgeLockHandle;
  token: string;
  stderrTail: string;
  stopRequested: boolean;
  /** 启动 settle 期内的退出由 start() 自己返回，不走 onExit 通知。 */
  startupPhase: boolean;
  exited: Promise<void>;
}

/** 从文本里抹掉 token 形态内容（本次 token 与任何 sk_agent_ 形态）。 */
export function redactSecrets(text: string, token: string): string {
  let out = token.length > 0 ? text.split(token).join("***") : text;
  out = out.replace(/sk_agent_[A-Za-z0-9_-]+/g, "***");
  return out;
}

export function createBridgeSupervisor(options: BridgeSupervisorOptions): BridgeSupervisorPort {
  const spawnFn = options.spawn ?? nodeSpawn;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const lockManager = createBridgeLock({
    dataRootDir: options.dataRootDir,
    isProcessAlive: options.isProcessAlive,
  });
  const running = new Map<string, Running>();
  const starting = new Set<string>();
  const listeners = new Set<(info: BridgeExitInfo) => void>();

  function emitExit(info: BridgeExitInfo): void {
    for (const listener of listeners) {
      try {
        listener(info);
      } catch (error) {
        options.logger?.warn("bridge exit listener failed", { error: String(error) });
      }
    }
  }

  /**
   * activity drain 端点：官方 bridge 默认把它派生成「唤醒端点的 origin + /activity/drain」
   * （整段 pathname 被替换，会丢掉 /<bindingId>/ 前缀），而唤醒服务按绑定分路由，
   * 所以必须显式传 --activity-channel-endpoint，否则每轮 drain 都 404 产生失败噪音。
   * 复用唤醒端点的 token（bridge 的 activity token 缺省即 wake token）。
   */
  function activityEndpointOf(endpointUrl: string): string {
    const url = new URL(endpointUrl);
    url.pathname = url.pathname.replace(/\/wake\/?$/u, "/activity/drain");
    url.search = "";
    return url.toString();
  }

  function buildArgs(binding: BridgeBindingRef, endpointUrl: string): string[] {
    // 身份固定：--profile 与 --expected-agent 都来自绑定记录；token 不在 argv 里。
    return [
      "--profile",
      binding.profileSlug,
      "agent",
      "bridge",
      `--expected-agent=${binding.raftAgentId}`,
      `--adapter-instance=${binding.bindingId}`,
      "--wake-adapter=wake-channel",
      `--wake-channel-endpoint=${endpointUrl}`,
      `--activity-channel-endpoint=${activityEndpointOf(endpointUrl)}`,
      "--json",
    ];
  }

  /** 进程树回收选项：POSIX 下 spawn 已 detached，pid 即本 supervisor 拥有的独立进程组。 */
  function treeOptions(child: ChildProcess, forceAfterMs: number): ProcessTreeTerminatorOptions {
    return {
      forceAfterMs,
      ...(process.platform !== "win32" && typeof child.pid === "number"
        ? { ownedProcessGroupId: child.pid }
        : {}),
      ...(options.logger
        ? {
            log: {
              debug: (...args: unknown[]) =>
                options.logger?.info("bridge process tree", { detail: args.map(String).join(" ") }),
              warn: (...args: unknown[]) =>
                options.logger?.warn("bridge process tree", { detail: args.map(String).join(" ") }),
            },
          }
        : {}),
    };
  }

  /**
   * 进程树整体回收（复用既有 process/processTreeTerminator，替换原先的裸
   * child.kill）：bridge CLI 可能再派生子进程，只杀直接子进程会留孤儿
   * （SPEC T2 原已知限制由此消除）。SIGTERM → 宽限 → SIGKILL 语义不变；
   * stop() 仍等 entry.exited（锁释放 + 端点关闭 + 通知完成之后才 resolve）。
   */
  async function terminate(id: string, entry: Running): Promise<void> {
    entry.stopRequested = true;
    const termination = await terminateProcessTreeAndWait(
      entry.child,
      treeOptions(entry.child, stopGraceMs),
    );
    if (termination.remainingPids.length > 0) {
      options.logger?.warn("bridge 进程树回收有残留 pid", {
        bindingId: id,
        remainingPids: [...new Set(termination.remainingPids)].join(","),
      });
    }
    await entry.exited;
  }

  return {
    async start(binding, cliPath): Promise<BridgeStartResult> {
      if (!options.ownerGuard.isOwner()) return { ok: false, code: "NotOwner" };
      const id = binding.bindingId;
      if (running.has(id) || starting.has(id)) return { ok: false, code: "AlreadyRunning" };
      starting.add(id);
      try {
        const lock = await lockManager.acquire(id);
        if (!lock) return { ok: false, code: "LockHeld" };

        let endpoint: { url: string; token: string };
        try {
          // 锁定契约（线程 6bf89974）：open 传 expectedAgentId，端点在 HTTP 层核对身份（spec §8.5）。
          endpoint = await options.wakeEndpoint.open(id, { expectedAgentId: binding.raftAgentId });
        } catch (error) {
          await lock.release();
          return { ok: false, code: "EndpointUnavailable", detail: String(error) };
        }

        let child: ChildProcess;
        try {
          child = spawnFn(cliPath, buildArgs(binding, endpoint.url), {
            env: sanitizedEnv({
              RAFT_PROFILE_DIR: join(options.dataRootDir, "raft", "profiles", binding.profileSlug),
              RAFT_CHANNEL_TOKEN: endpoint.token,
            }),
            stdio: ["ignore", "pipe", "pipe"],
            // POSIX 下进独立进程组：stop/terminateAllNow 才能按组回收整棵进程树
            // （bridge CLI 派生的孙进程不留孤儿）；Windows 保持非 detached，taskkill /T 处理。
            detached: shouldSpawnInDetachedProcessGroup(),
            windowsHide: true,
          });
        } catch (error) {
          await lock.release();
          await options.wakeEndpoint.close(id).catch(() => undefined);
          return {
            ok: false,
            code: "SpawnFailed",
            detail: redactSecrets(String(error), endpoint.token),
          };
        }

        let markExited: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => {
          markExited = resolve;
        });
        // Per-line redacted logging of bridge stdio (debugging aid; secrets scrubbed).
        const logBridgeLines = (tag: string, text: string): void => {
          for (const raw of text.split("\n")) {
            const line = raw.trim();
            if (line) options.logger?.info(tag, { bindingId: id, line: redactSecrets(line, endpoint.token) });
          }
        };
        const entry: Running = {
          child,
          lock,
          token: endpoint.token,
          stderrTail: "",
          stopRequested: false,
          startupPhase: true,
          exited,
        };
        running.set(id, entry);

        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          entry.stderrTail = (entry.stderrTail + text).slice(-STDERR_TAIL_BYTES);
          logBridgeLines("bridge stderr", text);
        });
        // 消费 stdout（NDJSON 诊断事件）防止管道写满阻塞子进程；排障期按行
        // redact 后落日志（PM/grokbot e2e 线程要求：bridge 侧唤醒尝试可观测）。
        child.stdout?.on("data", (chunk: Buffer) => logBridgeLines("bridge stdout", chunk.toString("utf8")));

        // 顺序（T3 约定）：先确认进程已退出，再释放锁、关闭唤醒端点，最后才通知；
        // stop()/stopAll() 等待的 exited 在这些清理完成之后才 resolve。
        const onEnd = async (code: number | null, signal: NodeJS.Signals | null) => {
          if (running.get(id) !== entry) return; // 已处理
          running.delete(id);
          await lock.release().catch(() => undefined);
          await options.wakeEndpoint.close(id).catch(() => undefined);
          const info: BridgeExitInfo = {
            bindingId: id,
            requested: entry.stopRequested,
            code,
            signal,
            stderrTail: redactSecrets(entry.stderrTail, endpoint.token),
          };
          options.logger?.info("bridge exited", {
            bindingId: id,
            code,
            signal,
            requested: entry.stopRequested,
          });
          markExited();
          // 主动停止不当作故障；启动 settle 期内的退出由 start() 自己返回，也不重复通知。
          if (!entry.stopRequested && !entry.startupPhase) emitExit(info);
        };
        child.once("error", (error) => {
          entry.stderrTail += `\n${String(error)}`;
          void onEnd(null, null);
        });
        child.once("close", (code, signal) => {
          void onEnd(code, signal);
        });

        // 等待 settle 期：期间退出说明参数/身份/环境有问题，作为启动失败返回。
        const settled = await Promise.race([
          entry.exited.then(() => "exited" as const),
          new Promise<"alive">((resolve) => setTimeout(() => resolve("alive"), settleMs)),
        ]);
        if (settled === "exited") {
          const tail = redactSecrets(entry.stderrTail, endpoint.token).trim();
          return {
            ok: false,
            code: "EarlyExit",
            detail: tail.length > 0 ? tail : "bridge 启动后立即退出",
          };
        }
        entry.startupPhase = false;
        options.logger?.info("bridge started", { bindingId: id, pid: child.pid ?? -1 });
        return { ok: true, pid: child.pid ?? -1 };
      } finally {
        starting.delete(id);
      }
    },

    async stop(bindingId) {
      const entry = running.get(bindingId);
      if (!entry) return;
      await terminate(bindingId, entry);
    },

    async stopAll() {
      await Promise.all([...running.entries()].map(([id, entry]) => terminate(id, entry)));
    },

    terminateAllNow() {
      // 同步收口路径（disposeHostResourcesBestEffort）不能 await：同步发树级 SIGTERM 并立即
      // 排定 SIGKILL（forceAfterMs 0，保持 timer 引用让它在进程退出前落地）；
      // 锁释放与端点关闭仍由 close 事件链异步完成。
      for (const entry of running.values()) {
        entry.stopRequested = true;
        terminateProcessTree(entry.child, { ...treeOptions(entry.child, 0), keepForceTimerRef: true });
      }
    },

    isRunning: (bindingId) => running.has(bindingId),

    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
