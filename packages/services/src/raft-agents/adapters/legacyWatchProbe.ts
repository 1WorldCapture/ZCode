/**
 * 旧产品（ZCode）只读探测（TinyCode 并排身份；grokbot 三道保险之一/三 + 复核 1/5）。
 *
 * 三个探测面：
 * 1. `probeLegacyWatchHeld`：某绑定的值守锁是否被存活 pid 持有（导入器 detect +
 *    compose → watchStartGates 启动门）。detect 面传 `unparsableAsHeld: true`
 *    （锁目录在但 owner 解析不了 = 归属不明，保守拒绝导入）；启动门保持 fail-open
 *    （旧根读取异常是常态，不能因此拦住本产品自己的值守）。
 * 2. `probeLegacyZCodeAppRunning`：ZCode 桌面主进程是否在运行（Chromium 单实例锁
 *    SingletonLock → readlink 取 pid → kill 0）。只依赖进程事实，不依赖 bridge 状态
 *    （ErrorPaused / 退避窗口 / 刚重启时锁不在，但进程在 → 双消费仍会发生）。
 * 3. `createLegacyWatchProbeFor`：宿主装配的启动门 probe 注入口。
 *
 * 安全纪律：**绝不回收、绝不写入**旧侧（回收是写操作）——只有能证明存活 pid 才算
 * held；陈旧锁（owner 已退出）不阻塞。
 */
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ZCODE_DATA_ROOT_NAME } from "@zcode/shared";

/** 旧产品数据根目录名（ZCode 历史固定名；TinyCode 构建下与自身 `.tinycode` 不同）。 */
export const LEGACY_ZCODE_DATA_ROOT_NAME = ".zcode";

/** 锁路径段白名单（与 bridgeLock 同款）。 */
const SAFE_BINDING_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * ZCode 桌面产品的 userData 目录名（Electron 默认 = productName）。
 * TinyCode 自身不在探测列表；Preview 同样可能持有值守，一并探测。
 */
const LEGACY_APP_PRODUCT_NAMES = ["ZCode", "ZCode Preview"] as const;

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
 *
 * `unparsableAsHeld`（grokbot 复核 5）：锁目录/文件存在但内容解析不出可判定的 pid
 * 时如何处置。detect（导入）面传 true——归属不明按持有拒绝；启动门缺省 false——
 * 读不出来不阻塞本产品值守（fail-open）。能证明 pid 已死（ESRCH）的一律不阻塞。
 */
export async function probeLegacyWatchHeld(
  legacyRootDir: string,
  bindingId: string,
  options?: { unparsableAsHeld?: boolean },
): Promise<boolean> {
  const unparsableAsHeld = options?.unparsableAsHeld === true;
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
    let raw: string;
    try {
      raw = (await readFile(lockPath, "utf8")).trim();
    } catch {
      return unparsableAsHeld;
    }
    let pid = Number.NaN;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === "number") pid = parsed.pid;
    } catch {
      /* 非 JSON：走裸数字 */
    }
    if (!Number.isSafeInteger(pid)) pid = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(pid) && pid > 0) return isProcessAlive(pid);
    return unparsableAsHeld;
  }
  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch {
    return unparsableAsHeld;
  }
  let sawOwnerEntry = false;
  let sawUnparsableOwner = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("owner-") || !entry.name.endsWith(".json")) {
      continue;
    }
    sawOwnerEntry = true;
    try {
      const parsed = JSON.parse(
        await readFile(join(lockPath, entry.name), "utf8"),
      ) as { pid?: unknown };
      if (
        typeof parsed.pid === "number" &&
        Number.isSafeInteger(parsed.pid) &&
        parsed.pid > 0 &&
        isProcessAlive(parsed.pid)
      ) {
        return true;
      }
    } catch {
      // 解析不了的 owner 无法证明存活：记 flag，继续扫其余 owner（可能有多个持有者）。
      sawUnparsableOwner = true;
    }
  }
  // 空锁目录（创建者崩溃未写 owner）或存在坏 owner 且无存活证明 → 按 mode 处置。
  if (unparsableAsHeld && (!sawOwnerEntry || sawUnparsableOwner)) return true;
  return false;
}

/**
 * 只读探测 ZCode 桌面主进程是否在运行（grokbot 复核 1）。
 *
 * Chromium 单实例锁：macOS 上是 userData 目录（`~/Library/Application Support/
 * <productName>`）内的 `SingletonLock` 符号链接，target 形如 `<hostname>-<pid>`
 * （hostname 可含 '-'，取最后一段）。pid 存活 = 运行中；链接在但解析不出 pid =
 * 保守视为运行（detect fail-closed 面）；ENOENT = 该形态未运行。
 *
 * 非 darwin 平台返回 false（Windows 单实例锁是 lockfile 文件形态，本期不做 Windows；
 * 探测失败面 fail-open 不阻塞导入流程本身）。
 */
export async function probeLegacyZCodeAppRunning(input?: {
  appSupportDir?: string;
}): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const base = input?.appSupportDir ?? join(homedir(), "Library", "Application Support");
  for (const productName of LEGACY_APP_PRODUCT_NAMES) {
    const lockPath = join(base, productName, "SingletonLock");
    let target: string;
    try {
      target = await readlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // 链接在但读不出（权限等）：保守视为运行。
      return true;
    }
    const dash = target.lastIndexOf("-");
    const pid = dash >= 0 ? Number.parseInt(target.slice(dash + 1), 10) : Number.NaN;
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (isProcessAlive(pid)) return true;
      continue; // 崩溃残留（pid 已死）：不算运行，继续查下一形态
    }
    // target 格式异常：保守视为运行。
    return true;
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
    // 启动门语义：fail-open（缺省不传 unparsableAsHeld）。
    isWatchHeld: (bindingId: string) => probeLegacyWatchHeld(legacyRootDir, bindingId),
  };
}
