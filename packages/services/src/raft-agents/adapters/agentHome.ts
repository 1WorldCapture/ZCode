/**
 * Agent Home 文件适配器（T5）：初始化与记忆可用性校验。
 *
 * 不变量：
 * 1. 初始化「缺失才写、永不覆盖」：用独占创建（wx），已有文件即便内容被用户改过也原样保留。
 * 2. 校验是只读闸门，不创建任何东西；MEMORY.md 必须是 Home 根下的普通文件（不接受符号链接，
 *    防止把任意文件读进模型上下文），非空。
 * 3. 目录权限 0700、文件 0600（记忆可能含协作细节）。
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentHomeInitInput,
  AgentHomePort,
  MemoryVerifyResult,
} from "../app/agentHomePorts.js";
import { renderAgentsTemplate, renderMemoryTemplate } from "../domain/agentHomeTemplates.js";

/** 独占创建文件；已存在返回 false，其余错误抛出。 */
async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function createAgentHomeAdapter(): AgentHomePort {
  return {
    async initialize(input: AgentHomeInitInput): Promise<void> {
      const home = input.homeWorkspacePath;
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(join(home, "notes"), { recursive: true, mode: 0o700 });
      await writeIfMissing(
        join(home, "MEMORY.md"),
        renderMemoryTemplate({ agentName: input.displayName, description: input.description }),
      );
      await writeIfMissing(
        join(home, "AGENTS.md"),
        renderAgentsTemplate({ agentName: input.displayName }),
      );
    },

    async verifyMemoryAvailable(input): Promise<MemoryVerifyResult> {
      const home = input.homeWorkspacePath;
      try {
        if (!(await lstat(home)).isDirectory())
          return { ok: false, code: "HomeMissing", detail: "Home 不是目录" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { ok: false, code: "HomeMissing" };
        return { ok: false, code: "HomeMissing", detail: (error as NodeJS.ErrnoException).code };
      }
      const memoryPath = join(home, "MEMORY.md");
      try {
        const stat = await lstat(memoryPath);
        if (!stat.isFile())
          return { ok: false, code: "MemoryUnreadable", detail: "MEMORY.md 不是普通文件" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { ok: false, code: "MemoryMissing" };
        return {
          ok: false,
          code: "MemoryUnreadable",
          detail: (error as NodeJS.ErrnoException).code,
        };
      }
      let content: string;
      try {
        content = await readFile(memoryPath, "utf8");
      } catch (error) {
        return {
          ok: false,
          code: "MemoryUnreadable",
          detail: (error as NodeJS.ErrnoException).code,
        };
      }
      if (content.trim().length === 0) return { ok: false, code: "MemoryEmpty" };
      return { ok: true };
    },
  };
}
