/**
 * 收件日志文件存储：`<ZCodeDataRoot>/raft/inbox-logs/<bindingId>/`。
 *
 * 一条日志一个文件（`<毫秒时间戳>-<随机后缀>.json`，0600）：
 * - 追加不重写已有内容，崩溃只可能损失当前这一条；
 * - 目录 0700，仅当前用户可读写；不放 Agent Home，防模型当普通文件改写；
 * - 文件名里的时间戳用于保留期清理，不依赖 mtime。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { InboxLogEntry, InboxLogPort } from "./ports.js";

// bindingId 只允许 uuid 形态字符，防止路径穿越。
const SAFE_BINDING_ID = /^[A-Za-z0-9-]{1,64}$/;
const FILE_NAME_PATTERN = /^(\d{13})-[0-9a-f]{8}\.json$/;

/** 私有原子写：先写 0600 临时文件再 rename，崩溃只会留下临时文件而不会留下半截日志。 */
async function writePrivateFileAtomically(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

export function createInboxLogStore(
  dataRootDir: string,
  nowMs: () => number = Date.now,
): InboxLogPort {
  function dirOf(bindingId: string): string {
    if (!SAFE_BINDING_ID.test(bindingId)) throw new Error("非法 bindingId");
    return join(dataRootDir, "raft", "inbox-logs", bindingId);
  }

  async function listFiles(dir: string): Promise<{ name: string; ts: number }[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: { name: string; ts: number }[] = [];
    for (const name of names) {
      const match = FILE_NAME_PATTERN.exec(name);
      if (match?.[1]) files.push({ name, ts: Number(match[1]) });
    }
    return files.sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name));
  }

  return {
    async append(bindingId, entry) {
      const dir = dirOf(bindingId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const name = `${String(nowMs()).padStart(13, "0")}-${randomUUID().replace(/-/g, "").slice(0, 8)}.json`;
      await writePrivateFileAtomically(join(dir, name), `${JSON.stringify(entry)}\n`);
    },

    async list(bindingId, opts) {
      const dir = dirOf(bindingId);
      const sinceMs = opts?.sinceIso ? Date.parse(opts.sinceIso) : 0;
      const entries: InboxLogEntry[] = [];
      for (const file of await listFiles(dir)) {
        if (Number.isFinite(sinceMs) && file.ts < sinceMs) continue;
        try {
          entries.push(JSON.parse(await readFile(join(dir, file.name), "utf8")) as InboxLogEntry);
        } catch {
          // 单条损坏不影响其余条目的补查。
        }
      }
      return entries;
    },

    async purge(bindingId, opts) {
      const dir = dirOf(bindingId);
      const cutoff = nowMs() - opts.olderThanMs;
      let removed = 0;
      for (const file of await listFiles(dir)) {
        if (file.ts >= cutoff) continue;
        try {
          await unlink(join(dir, file.name));
          removed += 1;
        } catch {
          // 删除失败留待下次清理。
        }
      }
      return removed;
    },

    async removeAll(bindingId) {
      await rm(dirOf(bindingId), { recursive: true, force: true });
    },
  };
}
