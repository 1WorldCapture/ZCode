/**
 * 每绑定一把跨进程锁：`<ZCodeDataRoot>/raft/locks/<bindingId>.lock`（ZCode 共享文件锁）。
 *
 * 目的：同一台机器上两个 ZCode 进程不会同时为同一绑定拉起 bridge（双消费者会争抢收件箱）。
 * 锁本体复用 `@zcode/shared/node` 的 acquireFileLock（目录锁 + owner 文件 + pid 存活检测 +
 * 陈旧锁回收 + 抢占期归属校验），这里只把它当非阻塞的 try-lock 用：短暂等待后仍被
 * 存活进程持有即返回 undefined（LockHeld）。升级前遗留的单文件 pid 锁由共享锁按旧格式回收。
 * 不能证明另一台机器上没有同一身份在运行（spec §14）。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { acquireFileLock } from "@zcode/shared/node";

const SAFE_BINDING_ID = /^[A-Za-z0-9-]{1,64}$/;
// try-lock 参数：maxWait 必须 >0，否则在尝试回收陈旧锁之前就判超时。
const TRY_LOCK_RETRY_DELAYS_MS = [25, 50, 100] as const;
const TRY_LOCK_OWNERLESS_GRACE_MS = 100;
const TRY_LOCK_MAX_WAIT_MS = 300;

export interface BridgeLockOptions {
  dataRootDir: string;
}

export interface BridgeLockHandle {
  release(): Promise<void>;
}

export function createBridgeLock(options: BridgeLockOptions) {
  function pathFor(bindingId: string): string {
    if (!SAFE_BINDING_ID.test(bindingId)) throw new Error("非法 bindingId");
    // acquireFileLock 在该路径后追加 `.lock`。
    return join(options.dataRootDir, "raft", "locks", bindingId);
  }

  return {
    /** 成功返回句柄；被另一个存活进程持有返回 undefined。 */
    async acquire(bindingId: string): Promise<BridgeLockHandle | undefined> {
      const path = pathFor(bindingId);
      await mkdir(join(options.dataRootDir, "raft", "locks"), { recursive: true, mode: 0o700 });
      try {
        const release = await acquireFileLock(
          path,
          TRY_LOCK_RETRY_DELAYS_MS,
          TRY_LOCK_OWNERLESS_GRACE_MS,
          TRY_LOCK_MAX_WAIT_MS,
        );
        return { release };
      } catch (error) {
        if (isZCodeFileLockTimeoutError(error)) return undefined;
        throw error;
      }
    },
  };
}
