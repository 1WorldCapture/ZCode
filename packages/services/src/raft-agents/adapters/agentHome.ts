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
 *    AGENTS.md 与 notes/**。删除整 Home 以归属标记（`.zcode-agent-home`，内容 bindingId）
 *    或默认位置派生为准；传入路径本身是符号链接即拒绝（评审定稿，线程 cb4426cd）。
 */
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

import { isResolvedPathWithin } from "@zcode/shared/node";

import { PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE } from "#src/memory/memory.js";
import { readProjectMemoryFileFromStableHandle } from "#src/memory/projectMemoryStableRead.js";

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

/** 归属标记文件名（内容 = bindingId，独占创建于绑定时；删除整 Home 的所有权证明）。 */
const HOME_OWNERSHIP_MARKER = ".zcode-agent-home";

/** 清记忆面三处（resetMemorySurface 与 deleteHome 的保留分支共用）；只在已解析目录内操作。 */
async function clearMemorySurfaceAt(homeReal: string): Promise<void> {
  await rm(join(homeReal, "MEMORY.md"), { force: true });
  await rm(join(homeReal, "AGENTS.md"), { force: true });
  await rm(join(homeReal, "notes"), { recursive: true, force: true });
}

/** 记忆面只读视图的单文件默认上限（512KB，超出截断并标志）。 */
export const MEMORY_FILE_MAX_BYTES = 512 * 1024;

/** readMemoryFile 的目录链越界错误码（validatePath 抛出后映射回 OutsideMemorySurface）。 */
const OUTSIDE_SURFACE_ERROR_CODE = "AGENT_MEMORY_OUTSIDE_SURFACE";

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

    async claimHomeOwnership(input): Promise<void> {
      // 已存在且非空 = 用户自选目录：不写标记（删除时走"保留目录"分支）。
      // ENOENT 视为空（ZCode 即将创建）；其余读取错误如实抛给 provisioning。
      try {
        const entries = await readdir(input.homeWorkspacePath);
        if (entries.length > 0) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(input.homeWorkspacePath, { recursive: true, mode: 0o700 });
      await writeIfMissing(
        join(input.homeWorkspacePath, HOME_OWNERSHIP_MARKER),
        `${input.bindingId}\n`,
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
      // 稳定读复用项目记忆原语（审核 #3）：O_NOFOLLOW 句柄 + 打开前后一致性校验，
      // 消掉 lstat→open 之间的替换竞态；validatePath 在句柄打开后复验目录链包含——
      // 中间目录（notes 等）被换成指向外部的符号链接即拒绝。
      // 上限 512KB 截断而非报错（记忆面只读视图语义，与项目记忆预览的报错语义不同）。
      const maxBytes = input.maxBytes ?? MEMORY_FILE_MAX_BYTES;
      const readOnce = () =>
        readProjectMemoryFileFromStableHandle({
          fileName: rel,
          filePath: target,
          validatePath: async () => {
            const parentReal = await realpath(dirname(target));
            if (!isResolvedPathWithin(parentReal, homeReal)) {
              throw Object.assign(new Error("resolved outside home"), {
                code: OUTSIDE_SURFACE_ERROR_CODE,
              });
            }
          },
          limits: { maxBytes, onOversize: "truncate" },
        });
      try {
        let read;
        try {
          read = await readOnce();
        } catch (error) {
          // CHANGED：与代理自身的原子写（rename）交错属正常竞态，重试一次再定论。
          if ((error as NodeJS.ErrnoException).code !== PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE) {
            throw error;
          }
          read = await readOnce();
        }
        return {
          ok: true,
          content: read.content,
          modifiedAt: new Date(read.updatedAt).toISOString(),
          truncated: read.truncated,
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === OUTSIDE_SURFACE_ERROR_CODE) {
          return { ok: false, code: "OutsideMemorySurface" as const, detail: "resolved outside home" };
        }
        return { ok: false, code: "Unreadable" as const, detail: code ?? String(error) };
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
        await clearMemorySurfaceAt(homeReal);
        return { ok: true };
      } catch (error) {
        return { ok: false, code: "ResetFailed" as const, detail: String(error) };
      }
    },

    async deleteHome(input) {
      // 守卫 1：先检查传入路径本身——是符号链接即拒绝（realpath 会把删除引到链接
      // 目标的整树，评审实测可删掉真实项目目录）；不是目录也拒绝。
      let given: Awaited<ReturnType<typeof lstat>>;
      try {
        given = await lstat(input.homeWorkspacePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // 幂等：目录已不存在，终态等价于已删除。
        if (code === "ENOENT") return { ok: true, home: "deleted" as const };
        return { ok: false, code: "Refused" as const, detail: code };
      }
      if (given.isSymbolicLink()) {
        return { ok: false, code: "Refused" as const, detail: "home path is a symlink" };
      }
      if (!given.isDirectory()) {
        return { ok: false, code: "Refused" as const, detail: "not a directory" };
      }
      let homeReal: string;
      try {
        homeReal = await realpath(input.homeWorkspacePath);
      } catch (error) {
        return { ok: false, code: "Refused" as const, detail: (error as NodeJS.ErrnoException).code };
      }
      // 守卫 2：拒绝文件系统根、用户主目录与数据根目录及其上级（homeReal 是它们的
      // 前缀或相等即拒绝——含 /Users、/Volumes 等主目录上级的真实路径形态）。
      let dataRootReal: string | undefined;
      try {
        dataRootReal = await realpath(input.dataRootDir);
      } catch {
        /* 数据根暂不可解析不阻断其余守卫 */
      }
      if (!isAbsolute(homeReal) || homeReal === sep) {
        return { ok: false, code: "Refused" as const, detail: "refusing to delete root-like path" };
      }
      for (const protectedRoot of dataRootReal ? [homedir(), dataRootReal] : [homedir()]) {
        if (isResolvedPathWithin(protectedRoot, homeReal)) {
          return {
            ok: false,
            code: "Refused" as const,
            detail: `refusing to delete protected root or its ancestor: ${protectedRoot}`,
          };
        }
      }
      // 守卫 3：归属判定。整删仅当 (a) 归属标记内容与 bindingId 一致，或 (b) Home
      // 恰为默认位置（路径由 bindingId 派生——兼容加标记前建的旧绑定）。
      let owned = false;
      try {
        owned = (await readFile(join(homeReal, HOME_OWNERSHIP_MARKER), "utf8")).trim() === input.bindingId;
      } catch {
        owned = false;
      }
      if (!owned && dataRootReal !== undefined) {
        owned = homeReal === join(dataRootReal, "agents", input.bindingId, "workspace");
      }
      if (!owned) {
        // 非自有目录（用户自选 / 旧绑定无标记 / 标记不匹配）：只清记忆三处与标记，
        // 保留目录本身，home="kept_memory_cleared" 由界面如实提示"已保留你的目录"。
        try {
          await clearMemorySurfaceAt(homeReal);
          await rm(join(homeReal, HOME_OWNERSHIP_MARKER), { force: true });
          return { ok: true, home: "kept_memory_cleared" as const };
        } catch (error) {
          return { ok: false, code: "Failed" as const, detail: String(error) };
        }
      }
      try {
        await rm(homeReal, { recursive: true, force: true });
        // 默认位置派生壳清理（收尾缺陷：agents/<id>/ 空目录残留）：父目录严格匹配
        // <dataRoot>/agents/<bindingId> 时用 rmdir 移除——rmdir 只删空目录，天然不误删；
        // 非空（并发写入/他物）或已不存在则保留，且不向上递归（agents/、dataRoot 不动）。
        // 壳清理失败不影响删除结果（Home 已删，终态达标）。
        if (dataRootReal !== undefined && dirname(homeReal) === join(dataRootReal, "agents", input.bindingId)) {
          try {
            await rmdir(dirname(homeReal));
          } catch {
            /* ENOTEMPTY / ENOENT：非空或已被清理，保留 */
          }
        }
        return { ok: true, home: "deleted" as const };
      } catch (error) {
        return { ok: false, code: "Failed" as const, detail: String(error) };
      }
    },
  };
}
