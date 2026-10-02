// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 导入器的目标侧复制安全助手（grokbot 第 5 条）：保权限、拒符号链接与特殊文件、
 * 新建路径全登记（失败回滚只清目标根内的半成品）。
 */
import { chmod, copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type LegacyImportErrorCode =
  | "copy-failed"
  | "symlink-refused"
  | "special-file-refused"
  | "legacy-stop-failed"
  | "verify-failed"
  | "not-available"
  /** ZCode 桌面主进程仍在运行（SingletonLock 探测命中）——拒绝写/导入。 */
  | "legacy-app-running"
  /** 写前再探发现绑定值守锁重新出现（grokbot 复核 2）。 */
  | "legacy-watch-held";

export class LegacyImportError extends Error {
  readonly code: LegacyImportErrorCode;
  constructor(code: LegacyImportErrorCode, message: string) {
    super(message);
    this.name = "LegacyImportError";
    this.code = code;
  }
}

/** 文件存在性（目录也返回 true；调用方随后按复制语义处理）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 逐级建目录并全部登记进 created（回滚要能清到空壳为止；mkdir recursive 会留下
 * 未登记的中间目录）。已存在（含目标根）即停。
 */
export async function ensureTrackedDir(
  dir: string,
  created: string[],
  mode = 0o700,
): Promise<void> {
  const missing: string[] = [];
  let current = dir;
  for (;;) {
    if (await pathExists(current)) break;
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of [...missing].reverse()) {
    await mkdir(path, { mode });
    created.push(path);
  }
}

/**
 * 保权限、拒符号链接的只读树复制。created 记录目标侧新建路径（回滚删除用），
 * 全部位于 targetRoot 之下——由调用方在 rm 前再校验一次（回滚红线：只清新根）。
 */
export async function copyTreeInto(
  src: string,
  dest: string,
  targetRootDir: string,
  created: string[],
): Promise<void> {
  const stat = await lstat(src);
  if (stat.isSymbolicLink()) {
    throw new LegacyImportError("symlink-refused", `symlink not importable: ${src}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new LegacyImportError("special-file-refused", `not a regular file or directory: ${src}`);
  }
  if (
    resolve(dirname(dest)) !== resolve(targetRootDir) &&
    !resolve(dirname(dest)).startsWith(`${resolve(targetRootDir)}${sep}`)
  ) {
    throw new LegacyImportError("copy-failed", `destination escapes target root: ${dest}`);
  }
  if (stat.isFile()) {
    await ensureTrackedDir(dirname(dest), created);
    await copyFile(src, dest);
    await chmod(dest, stat.mode & 0o777);
    created.push(dest);
    return;
  }
  await ensureTrackedDir(dirname(dest), created);
  await mkdir(dest, { mode: stat.mode & 0o777 });
  // mkdir 的 mode 受 umask 影响，chmod 补齐源目录真实权限（如 0700）。
  await chmod(dest, stat.mode & 0o777).catch(() => {});
  created.push(dest);
  for (const entry of await readdir(src, { withFileTypes: true })) {
    await copyTreeInto(join(src, entry.name), join(dest, entry.name), targetRootDir, created);
  }
}
