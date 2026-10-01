/**
 * 绑定记录文件存储：`<ZCodeDataRoot>/raft/bindings.json`。
 *
 * 读写都走 withFileLock + 原子写（tmp+rename，0600）。损坏文件 fail-closed
 * （审核报告 D3 / 与 credentialService 同口径）：backupCorruptFile 保全证据后
 * **报错**，原文件原样保留；上层暂停值守并提示用户恢复——绝不自动清空
 * （清空会让正在跑的 bridge 变孤儿、绑定永久丢失）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { raftAgentsConfigFileSchema, type RaftAgentBinding } from "@zcode/shared";
import { withFileLock, atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";

import type { RaftBindingStorePort } from "../app/ports.js";

const BINDINGS_FILE = "bindings.json";

/** 绑定存储损坏（fail-closed）：证据已保全、原文件保留，等待用户手动恢复。 */
export class RaftBindingStoreCorruptError extends Error {
  constructor(
    readonly storePath: string,
    readonly backupPath?: string,
  ) {
    super(`raft bindings store is corrupt: ${storePath}`);
    this.name = "RaftBindingStoreCorruptError";
  }
}

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
          // 损坏：保全证据后报错，原文件保留（fail-closed）。绝不按空集继续——
          // 那样下一次写入会永久抹掉全部绑定，正在跑的 bridge 也成了无人管理的孤儿。
          const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
          throw new RaftBindingStoreCorruptError(filePath, backupPath);
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
