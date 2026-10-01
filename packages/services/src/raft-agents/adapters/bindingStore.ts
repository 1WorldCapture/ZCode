/**
 * 绑定记录文件存储：`<ZCodeDataRoot>/raft/bindings.json`。
 *
 * 读写都走 withFileLock + 原子写（tmp+rename，0600）；损坏文件用共享库
 * backupCorruptFile 保全证据（内容寻址、0600）后删除原文件完成隔离，
 * 按空集处理（绑定记录丢失是可恢复的，不能让应用起不来）。
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { raftAgentsConfigFileSchema, type RaftAgentBinding } from "@zcode/shared";
import { withFileLock, atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";

import type { RaftBindingStorePort } from "../app/ports.js";

const BINDINGS_FILE = "bindings.json";

export function createRaftBindingStore(dataRootDir: string): RaftBindingStorePort {
  const filePath = join(dataRootDir, "raft", BINDINGS_FILE);

  async function readRaw(): Promise<string | undefined> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  return {
    async readAll(): Promise<RaftAgentBinding[]> {
      return withFileLock(filePath, async () => {
        const raw = await readRaw();
        if (raw === undefined) return [];
        try {
          const parsed = raftAgentsConfigFileSchema.parse(JSON.parse(raw));
          return parsed.bindings;
        } catch {
          // 损坏文件：先备份保全证据，再隔离原文件（避免每次读取重复解析失败）；
          // 备份失败则不删原件，下次读取重试同一收敛路径。之后按空集返回。
          try {
            await backupCorruptFile(filePath);
            await rm(filePath, { force: true });
          } catch {
            // 保全/隔离失败也继续按空集返回。
          }
          return [];
        }
      });
    },

    async writeAll(bindings: RaftAgentBinding[]): Promise<void> {
      const parsed = raftAgentsConfigFileSchema.parse({ version: 1, bindings });
      await withFileLock(filePath, async () => {
        await mkdir(join(dataRootDir, "raft"), { recursive: true });
        await atomicWritePrivateTextFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      });
    },
  };
}
