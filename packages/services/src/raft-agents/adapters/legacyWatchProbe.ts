/**
 * 旧产品（ZCode）值守锁只读探测（TinyCode 并排身份；grokbot 三道保险之一/三）。
 *
 * 两个消费方：
 * - 导入器 detect：值守中（存活 pid 持锁）拒绝导入；
 * - compose → watchStartGates：本产品每次启动绑定值守前再探测一次旧侧锁。
 *
 * 安全纪律：**绝不回收、绝不写入**旧侧（回收是写操作）——只有能证明存活 pid 才算
 * held；陈旧锁（owner 已退出）不阻塞，读不出来也不阻塞（fail-open + 调用方日志）。
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ZCODE_DATA_ROOT_NAME } from "@zcode/shared";

/** 旧产品数据根目录名（ZCode 历史固定名；TinyCode 构建下与自身 `.tinycode` 不同）。 */
export const LEGACY_ZCODE_DATA_ROOT_NAME = ".zcode";

/** 锁路径段白名单（与 bridgeLock 同款）。 */
const SAFE_BINDING_ID = /^[A-Za-z0-9-]{1,64}$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * 只读探测旧侧某绑定的值守锁是否被存活进程持有。
 *
 * 锁形态与 @zcode/shared/node acquireFileLock 一致：`<bindingId>.lock/` 目录内
 * `owner-*.json`（{pid, createdAt}）；升级前遗留形态是同名单文件。
 */
export async function probeLegacyWatchHeld(
  legacyRootDir: string,
  bindingId: string,
): Promise<boolean> {
  if (!SAFE_BINDING_ID.test(bindingId)) return false;
  const lockPath = join(legacyRootDir, "raft", "locks", `${bindingId}.lock`);
  let stat;
  try {
    stat = await lstat(lockPath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) return false;
  if (!stat.isDirectory()) {
    // 旧格式单文件锁：内容为 JSON（{pid}）或裸数字，两种都认（JSON.parse 能吃下裸数字，
    // 所以 pid 字段缺失时仍要回落裸数字解析）。
    try {
      const raw = (await readFile(lockPath, "utf8")).trim();
      let pid = Number.NaN;
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
      } catch {
        /* 非 JSON：走裸数字 */
      }
      if (!Number.isSafeInteger(pid)) pid = Number.parseInt(raw, 10);
      return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid);
    } catch {
      return false;
    }
  }
  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("owner-") || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(join(lockPath, entry.name), "utf8")) as {
        pid?: unknown;
      };
      if (
        typeof parsed.pid === "number" &&
        Number.isSafeInteger(parsed.pid) &&
        parsed.pid > 0 &&
        isProcessAlive(parsed.pid)
      ) {
        return true;
      }
    } catch {
      /* 解析不了的 owner 无法证明存活：继续扫其余 owner */
    }
  }
  return false;
}

/**
 * 供 compose / 宿主装配：同产品（数据根同名）没有「旧侧」概念，返回 undefined；
 * 并排身份（TinyCode 的 `.tinycode` vs `.zcode`）返回只读 probe，接进 watchStartGates。
 */
export function createLegacyWatchProbeFor(dataRootDir: string): {
  isWatchHeld: (bindingId: string) => Promise<boolean>;
  legacyRootDir: string;
} | undefined {
  if (ZCODE_DATA_ROOT_NAME === LEGACY_ZCODE_DATA_ROOT_NAME) return undefined;
  const legacyRootDir = join(dirname(resolve(dataRootDir)), LEGACY_ZCODE_DATA_ROOT_NAME);
  return {
    legacyRootDir,
    isWatchHeld: (bindingId: string) => probeLegacyWatchHeld(legacyRootDir, bindingId),
  };
}
