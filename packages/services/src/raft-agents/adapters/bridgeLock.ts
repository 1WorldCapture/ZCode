/**
 * 每绑定一个 pid 锁文件：`<ZCodeDataRoot>/raft/locks/<bindingId>.lock`。
 *
 * 目的：同一台机器上两个 ZCode 进程不会同时为同一绑定拉起 bridge（双消费者会争抢收件箱）。
 * 锁的持有者是拉起 bridge 的 ZCode 宿主进程（写入其 pid）；持有者已不存在（崩溃遗留）
 * 视为陈旧锁，清除后重试一次。不能证明另一台机器上没有同一身份在运行（spec §14）。
 */
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const SAFE_BINDING_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface BridgeLockOptions {
  dataRootDir: string;
  /** 测试注入：判断某 pid 是否存活。 */
  isProcessAlive?: (pid: number) => boolean;
  ownerPid?: number;
}

export interface BridgeLockHandle {
  release(): Promise<void>;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号，同样视为存活。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createBridgeLock(options: BridgeLockOptions) {
  const alive = options.isProcessAlive ?? defaultIsProcessAlive;
  const ownerPid = options.ownerPid ?? process.pid;

  function pathFor(bindingId: string): string {
    if (!SAFE_BINDING_ID.test(bindingId)) throw new Error("非法 bindingId");
    return join(options.dataRootDir, "raft", "locks", `${bindingId}.lock`);
  }

  async function tryCreate(path: string): Promise<boolean> {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(String(ownerPid));
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  return {
    /** 成功返回句柄；被另一个存活进程持有返回 undefined。 */
    async acquire(bindingId: string): Promise<BridgeLockHandle | undefined> {
      const path = pathFor(bindingId);
      await mkdir(join(options.dataRootDir, "raft", "locks"), { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (await tryCreate(path)) {
          return {
            release: async () => {
              // 只删自己写的锁，避免误删被别人接管后的锁。
              try {
                if (Number((await readFile(path, "utf8")).trim()) === ownerPid) await unlink(path);
              } catch {
                // 锁文件已不存在，视为已释放。
              }
            },
          };
        }
        let holder = Number.NaN;
        try {
          holder = Number((await readFile(path, "utf8")).trim());
        } catch {
          continue; // 读取时被释放，重试创建。
        }
        if (Number.isInteger(holder) && holder > 0 && holder !== ownerPid && alive(holder))
          return undefined;
        // 陈旧锁（持有者已退出或损坏内容）：清除后重试。
        await unlink(path).catch(() => undefined);
      }
      return undefined;
    },
  };
}
