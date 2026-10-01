/**
 * Agent Home 文件适配器（T5 + 二期 A1）：初始化、记忆可用性校验、记忆面只读视图、
 * 重置与 Home 删除。
 *
 * 不变量：
 * 1. 初始化「缺失才写、永不覆盖」：用独占创建（wx），已有文件即便内容被用户改过也原样保留。
 * 2. 校验是只读闸门，不创建任何东西；MEMORY.md 必须是 Home 根下的普通文件（不接受符号链接，
 *    防止把任意文件读进模型上下文），非空。
 * 3. 目录权限 0700、文件 0600（记忆可能含协作细节）。
 * 4. 二期 A1 只读/删除面：路径判定统一在 realpath 两侧做（macOS /var → /private/var 一类
 *    根别名不误判；Home 内指向外部的符号链接解析后拒绝）。记忆面 = 根下 MEMORY.md、
 *    AGENTS.md 与 notes/**。
 */
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

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

/** 记忆面只读视图的单文件默认上限（512KB，超出截断并标志）。 */
export const MEMORY_FILE_MAX_BYTES = 512 * 1024;

/** realpath 判包含：target 必须等于 root 或落在 root 之下（两侧都已规范化）。 */
function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** 记忆面路径合法性：仅根下 MEMORY.md / AGENTS.md / notes/**（拒绝 ../、绝对路径、空段）。 */
function memorySurfaceRelativePath(path: string): string | undefined {
  if (path === "MEMORY.md" || path === "AGENTS.md") return path;
  if (!path.startsWith("notes/")) return undefined;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return undefined;
  if (segments[0] !== "notes" || segments.length < 2) return undefined;
  return segments.join("/");
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

    async listMemoryFiles(input) {
      let homeReal: string;
      try {
        homeReal = await realpath(input.homeWorkspacePath);
      } catch {
        return { ok: false, code: "HomeMissing" as const };
      }
      const files: Array<{ path: string; size: number; modifiedAt: string }> = [];
      const pushIfRegular = async (absPath: string, relPath: string) => {
        try {
          const s = await lstat(absPath);
          if (s.isFile()) {
            files.push({ path: relPath, size: s.size, modifiedAt: new Date(s.mtimeMs).toISOString() });
          }
        } catch {
          /* 缺失即跳过 */
        }
      };
      await pushIfRegular(join(homeReal, "MEMORY.md"), "MEMORY.md");
      await pushIfRegular(join(homeReal, "AGENTS.md"), "AGENTS.md");
      // notes/** 递归；目录项里的符号链接不跟随（lstat 只认普通文件）。
      const walk = async (dirRel: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(join(homeReal, dirRel), { withFileTypes: true });
        } catch {
          return; // notes 不存在（全新/已重置）是合法状态
        }
        for (const entry of entries) {
          const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
          if (entry.isDirectory()) await walk(rel);
          else if (entry.isFile()) await pushIfRegular(join(homeReal, rel), rel);
        }
      };
      await walk("notes");
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { ok: true, files };
    },

    async readMemoryFile(input) {
      const rel = memorySurfaceRelativePath(input.path);
      if (rel === undefined) {
        return { ok: false, code: "OutsideMemorySurface" as const, detail: "not in memory surface" };
      }
      let homeReal: string;
      try {
        homeReal = await realpath(input.homeWorkspacePath);
      } catch {
        return { ok: false, code: "NotFound" as const, detail: "home missing" };
      }
      const target = join(homeReal, rel);
      try {
        // 符号链接拒绝（与 MEMORY 门同判据）：只接受记忆面里的普通文件。
        const s = await lstat(target);
        if (!s.isFile()) {
          return { ok: false, code: "OutsideMemorySurface" as const, detail: "not a regular file" };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT"
          ? { ok: false, code: "NotFound" as const }
          : { ok: false, code: "Unreadable" as const, detail: code };
      }
      // realpath 两侧包含判定：Home 内指向外部的符号链接已由 lstat 挡住，
      // 这里再防目录本身经链接给出（与 confineFileToolsToWorkspace 同口径）。
      const targetReal = await realpath(target);
      if (!isWithin(targetReal, homeReal)) {
        return { ok: false, code: "OutsideMemorySurface" as const, detail: "resolved outside home" };
      }
      const maxBytes = input.maxBytes ?? MEMORY_FILE_MAX_BYTES;
      try {
        const handle = await open(target, "r");
        try {
          const fileStat = await handle.stat();
          const length = Math.min(fileStat.size, maxBytes);
          const { buffer, bytesRead } = await handle.read({
            buffer: Buffer.alloc(length),
            position: 0,
            length,
          });
          return {
            ok: true,
            content: buffer.subarray(0, bytesRead).toString("utf8"),
            modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
            truncated: fileStat.size > maxBytes,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        return { ok: false, code: "Unreadable" as const, detail: (error as NodeJS.ErrnoException).code };
      }
    },

    async resetMemorySurface(input) {
      let homeReal: string;
      try {
        homeReal = await realpath(input.homeWorkspacePath);
      } catch {
        return { ok: false, code: "HomeMissing" as const };
      }
      try {
        await rm(join(homeReal, "MEMORY.md"), { force: true });
        await rm(join(homeReal, "AGENTS.md"), { force: true });
        await rm(join(homeReal, "notes"), { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, code: "ResetFailed" as const, detail: String(error) };
      }
    },

    async deleteHome(input) {
      let homeReal: string;
      try {
        homeReal = await realpath(input.homeWorkspacePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { ok: true }; // 幂等：已不存在视为成功
        return { ok: false, code: "Refused" as const, detail: code };
      }
      if (!isAbsolute(homeReal) || homeReal === sep || homeReal === homedir() || homeReal === homedir() + sep) {
        return { ok: false, code: "Refused" as const, detail: "refusing to delete root-like path" };
      }
      if (isWithin(homeReal, homedir()) && !homeReal.includes(`${sep}agents${sep}`)) {
        // Home 在用户主目录下但不位于任何 agents/ 结构里：要求标记文件在场，
        // 防误删形似 Home 的任意用户目录。
        const markers = await Promise.all(
          ["MEMORY.md", "AGENTS.md", "notes"].map(async (m) => {
            try {
              return await lstat(join(homeReal, m));
            } catch {
              return undefined;
            }
          }),
        );
        if (!markers.some((s) => s !== undefined)) {
          return { ok: false, code: "Refused" as const, detail: "no agent-home marker files" };
        }
      }
      try {
        if (!(await stat(homeReal)).isDirectory()) {
          return { ok: false, code: "Refused" as const, detail: "not a directory" };
        }
        await rm(homeReal, { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, code: "Failed" as const, detail: String(error) };
      }
    },
  };
}
