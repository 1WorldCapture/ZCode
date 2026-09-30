/**
 * 绑定记录文件存储：`<ZCodeDataRoot>/raft/bindings.json`。
 *
 * 读写都走 withFileLock + 原子写（tmp+rename，0600）；损坏文件隔离后
 * 重建空集（与 settingService 的读加固模式一致）。绑定数据不含任何
 * 凭据，权限要求跟随应用管理数据的统一约定。
 */
import { rename, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { raftAgentsConfigFileSchema, type RaftAgentBinding } from "@zcode/shared";
import { withFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";

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
          // 损坏文件隔离为 .corrupt-<ts>.json 后按空集处理：
          // 绑定记录丢失是可恢复的（重新接入即可），不能让应用起不来。
          const backup = `${filePath}.corrupt-${Date.now()}.json`;
          try {
            await rename(filePath, backup);
          } catch {
            // 隔离失败也继续按空集返回。
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
