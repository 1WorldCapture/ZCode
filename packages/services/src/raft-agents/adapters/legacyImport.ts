/**
 * 存量 ZCode 绑定只读导入器（TinyCode 首启；task #28 PM 决定③ + grokbot 九条）。
 *
 * 职责：把旧产品数据根（`~/.zcode`）下的 Raft 接入事实复制到本产品数据根
 * （编译期 ZCODE_DATA_ROOT_NAME，TinyCode 构建为 `~/.tinycode`）：
 * - `raft/bindings.json`（改写 homeWorkspacePath / 清 mainSessionRef / 按勾选定 desiredState）
 * - `raft/profiles/<slug>/`（凭据 + agent-comms-core，整目录，保权限）
 * - `raft/agents/<bindingId>/workspace`（默认位置 Agent Home：记忆 + 归属标记）
 * - `raft/inbox-logs/<bindingId>/`（claim→落盘→ack 去重靠它，D8 语义）
 * 不迁：会话库（PM 决定②）、`raft/locks`（锁属进程实例）、账号登录态 credentials.json
 * （PM 决定：TinyCode 需重新登录）。
 *
 * 安全纪律（grokbot 九条 + PM 硬要求）：
 * - 源侧探测/读取全程只读；唯一允许的源侧写 = 用户勾选「同时停止 ZCode 侧值守」时
 *   改写这几个绑定的 desiredState（legacyImportStop.ts，先备份、原子写、校验、可还原）。
 * - 源侧值守中（locks 有存活 pid）拒绝导入（legacyWatchProbe.ts）。
 * - 复制拒绝符号链接与非常规文件；文件保 mode（credential.json 0600）（legacyImportCopy.ts）。
 * - 失败回滚只清本产品数据根内的半成品；源侧已做的停止写用备份还原。
 * - token/凭据内容永不进日志与错误信息：日志只带 bindingId / slug / 路径 / 计数。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { raftAgentsConfigFileSchema, type RaftAgentBinding } from "@zcode/shared";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import { createRaftBindingStore } from "./bindingStore.js";
import {
  LegacyImportError,
  copyTreeInto,
  ensureTrackedDir,
  pathExists,
} from "./legacyImportCopy.js";
import { stopLegacyWatch } from "./legacyImportStop.js";
import { probeLegacyWatchHeld } from "./legacyWatchProbe.js";

/** 与 profilesCatalog 同口径的 slug 白名单（天然排除路径分隔与 `..`）。 */
const PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type LegacyImportSkipReason =
  | "same-root"
  | "target-not-empty"
  | "target-corrupt"
  | "source-missing"
  | "source-corrupt"
  | "invalid-binding"
  | "no-bindings"
  | "legacy-watch-held"
  | "already-declined";

export interface LegacyImportBindingPreview {
  bindingId: string;
  displayName: string;
  profileSlug: string;
  desiredState: RaftAgentBinding["desiredState"];
  /** default = 旧根 agents/<id>/workspace（随导入复制）；custom = 用户自选目录（保留原路径，不复制）。 */
  homeKind: "default" | "custom";
  homeWorkspacePath: string;
}

export interface LegacyImportPreview {
  sourceRootDir: string;
  targetRootDir: string;
  bindings: LegacyImportBindingPreview[];
  /** 值守中（存活 pid 持锁）的 bindingId；非空时 detect 不给 available。 */
  heldBindingIds: string[];
}

export type LegacyImportDetection =
  | { status: "not-available"; reason: LegacyImportSkipReason; detail?: string }
  | { status: "available"; preview: LegacyImportPreview };

export interface LegacyImportResult {
  importedCount: number;
  /** 用户勾选时已完成源侧停止写（备份在 backupPath）。 */
  stoppedInLegacy: boolean;
  backupPath?: string;
  /** 非致命问题（如 profile 目录缺失）：导入完成但该绑定凭据会显示待核验。 */
  warnings: string[];
}

export interface LegacyZCodeImporterOptions {
  /** 旧产品数据根（如 ~/.zcode）。 */
  sourceRootDir: string;
  /** 本产品数据根（如 ~/.tinycode）。 */
  targetRootDir: string;
  logger?: ServiceLogger;
  /** 测试注入：时间戳。 */
  now?: () => Date;
}

/** 目录锁形态下读取 bindings.json（与 bindingStore 同解析，但绝不触发损坏备份写）。 */
async function readBindingsFile(
  rootDir: string,
): Promise<{ ok: true; bindings: RaftAgentBinding[] } | { ok: false; reason: "missing" | "corrupt" }> {
  let raw: string;
  try {
    raw = await readFile(join(rootDir, "raft", "bindings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "corrupt" };
  }
  try {
    return { ok: true, bindings: raftAgentsConfigFileSchema.parse(JSON.parse(raw)).bindings };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

function legacyHomeDir(sourceRootDir: string, bindingId: string): string {
  return join(sourceRootDir, "agents", bindingId, "workspace");
}

/** 复制单元清单 → 实际复制路径（失败回滚与 mkdir 都以它为界）。 */
interface ImportPlan {
  bindings: LegacyImportBindingPreview[];
  profileDirs: string[];
  inboxDirs: string[];
}

export function createLegacyZCodeImporter(options: LegacyZCodeImporterOptions) {
  const sourceRootDir = resolve(options.sourceRootDir);
  const targetRootDir = resolve(options.targetRootDir);
  const logger = options.logger;
  const now = options.now ?? (() => new Date());
  const sourceBindingsPath = join(sourceRootDir, "raft", "bindings.json");

  function planFrom(bindings: RaftAgentBinding[]): ImportPlan {
    return {
      bindings: bindings.map((binding) => {
        const defaultHome = legacyHomeDir(sourceRootDir, binding.bindingId);
        const homeKind = binding.homeWorkspacePath === defaultHome ? "default" : "custom";
        return {
          bindingId: binding.bindingId,
          displayName: binding.displayName,
          profileSlug: binding.profileSlug,
          desiredState: binding.desiredState,
          homeKind,
          homeWorkspacePath: binding.homeWorkspacePath,
        };
      }),
      profileDirs: bindings.map((binding) => binding.profileSlug),
      inboxDirs: bindings.map((binding) => binding.bindingId),
    };
  }

  async function detect(): Promise<LegacyImportDetection> {
    if (sourceRootDir === targetRootDir) {
      return { status: "not-available", reason: "same-root" };
    }
    if (await pathExists(join(targetRootDir, "raft", "legacy-import-declined"))) {
      return { status: "not-available", reason: "already-declined" };
    }
    const targetRead = await readBindingsFile(targetRootDir);
    if (targetRead.ok) {
      if (targetRead.bindings.length > 0) return { status: "not-available", reason: "target-not-empty" };
    } else if (targetRead.reason === "corrupt") {
      // 目标文件损坏属 fail-closed 面（bindingStore 语义）：绝不在其上导入。
      return { status: "not-available", reason: "target-corrupt" };
    }
    const sourceRead = await readBindingsFile(sourceRootDir);
    if (!sourceRead.ok) {
      return {
        status: "not-available",
        reason: sourceRead.reason === "missing" ? "source-missing" : "source-corrupt",
      };
    }
    const bindings = sourceRead.bindings;
    if (bindings.length === 0) return { status: "not-available", reason: "no-bindings" };
    for (const binding of bindings) {
      if (!PROFILE_SLUG_PATTERN.test(binding.profileSlug)) {
        return {
          status: "not-available",
          reason: "invalid-binding",
          detail: `profileSlug fails safety pattern: ${binding.profileSlug}`,
        };
      }
    }
    const heldBindingIds: string[] = [];
    for (const binding of bindings) {
      if (await probeLegacyWatchHeld(sourceRootDir, binding.bindingId)) {
        heldBindingIds.push(binding.bindingId);
      }
    }
    if (heldBindingIds.length > 0) {
      return { status: "not-available", reason: "legacy-watch-held", detail: heldBindingIds.join(",") };
    }
    const plan = planFrom(bindings);
    return {
      status: "available",
      preview: {
        sourceRootDir,
        targetRootDir,
        bindings: plan.bindings,
        heldBindingIds,
      },
    };
  }

  async function importBindings(input: {
    stopLegacyBindings: boolean;
  }): Promise<LegacyImportResult> {
    const detection = await detect();
    if (detection.status !== "available") {
      throw new LegacyImportError(
        "not-available",
        `legacy import no longer available: ${detection.reason}${detection.detail ? ` (${detection.detail})` : ""}`,
      );
    }
    const sourceRead = await readBindingsFile(sourceRootDir);
    if (!sourceRead.ok) throw new LegacyImportError("not-available", "source vanished mid-import");
    const plan = planFrom(sourceRead.bindings);
    const warnings: string[] = [];
    const created: string[] = [];
    const targetReal = resolve(targetRootDir);
    // 源侧停止写一旦成功，后续任何失败都必须把它逐字节还原（回滚不触碰源数据的例外
    // 只存在于它自身内部）；stopState 在步骤 4 赋值。
    let stopState: { backupPath: string; originalContent: string } | undefined;

    /** 回滚红线：只删本产品数据根内、且只删本次新建的路径。 */
    const rollbackTarget = async (): Promise<void> => {
      for (const path of [...created].reverse()) {
        const real = resolve(path);
        if (real === targetReal || !real.startsWith(`${targetReal}${sep}`)) {
          logger?.warn(undefined, "legacy import rollback: skip path outside target root", { path });
          continue;
        }
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
    };

    try {
      // 1) profiles（缺目录：非致命，绑定凭据会显示待核验）。
      for (const slug of plan.profileDirs) {
        const src = join(sourceRootDir, "raft", "profiles", slug);
        if (!(await pathExists(src))) {
          warnings.push(`profile directory missing for slug ${slug}`);
          continue;
        }
        await copyTreeInto(src, join(targetRootDir, "raft", "profiles", slug), targetRootDir, created);
      }
      // 2) 默认位置 Agent Home（custom Home 保留原绝对路径，不复制用户目录）。
      for (const binding of plan.bindings) {
        if (binding.homeKind !== "default") continue;
        const src = legacyHomeDir(sourceRootDir, binding.bindingId);
        if (!(await pathExists(src))) {
          warnings.push(`agent home missing for ${binding.bindingId}`);
          continue;
        }
        await copyTreeInto(
          src,
          join(targetRootDir, "agents", binding.bindingId, "workspace"),
          targetRootDir,
          created,
        );
      }
      // 3) inbox-logs（缺 = 正常，全新绑定从未值守过）。
      for (const bindingId of plan.inboxDirs) {
        const src = join(sourceRootDir, "raft", "inbox-logs", bindingId);
        if (!(await pathExists(src))) continue;
        await copyTreeInto(src, join(targetRootDir, "raft", "inbox-logs", bindingId), targetRootDir, created);
      }

      // 4) 源侧停止写（勾选时；失败即整体回滚，含备份还原）。
      if (input.stopLegacyBindings) {
        stopState = await stopLegacyWatch({
          sourceBindingsPath,
          importedIds: new Set(plan.bindings.map((b) => b.bindingId)),
          now,
        });
      }

      // 5) 提交：目标 bindings.json（原子 + 锁内，bindingStore 语义）。
      const updatedAt = now().toISOString();
      const imported: RaftAgentBinding[] = sourceRead.bindings.map((binding) => {
        const preview = plan.bindings.find((b) => b.bindingId === binding.bindingId)!;
        return {
          ...binding,
          homeWorkspacePath:
            preview.homeKind === "default"
              ? join(targetRootDir, "agents", binding.bindingId, "workspace")
              : binding.homeWorkspacePath,
          // 会话不迁移（PM 决定②）：引用指向 ZCode 侧会话库，必须清空。
          mainSessionRef: null,
          // 勾选停止 → 保留原 desiredState（旧侧已停，无双消费；Running 导入即恢复值守）。
          // 未勾选 → 一律置停止（grokbot 第 4 条：防两边同时值守）。
          desiredState: input.stopLegacyBindings ? binding.desiredState : "ReadyStopped",
          updatedAt,
        };
      });
      const store = createRaftBindingStore(targetRootDir);
      await store.writeAll(imported);
      created.push(join(targetRootDir, "raft", "bindings.json"));

      // 6) 终验：目标可解析且数量一致。
      const verify = await store.readAll();
      if (verify.length !== imported.length) {
        throw new LegacyImportError("verify-failed", "target binding count mismatch after import");
      }
      logger?.info(undefined, "legacy zcode import completed", {
        importedCount: imported.length,
        stoppedInLegacy: input.stopLegacyBindings,
        backupPath: stopState?.backupPath,
        warningCount: warnings.length,
      });
      return {
        importedCount: imported.length,
        stoppedInLegacy: input.stopLegacyBindings,
        ...(stopState ? { backupPath: stopState.backupPath } : {}),
        warnings,
      };
    } catch (error) {
      const importError = error instanceof LegacyImportError ? error : new LegacyImportError(
        stopState ? "legacy-stop-failed" : "copy-failed",
        error instanceof Error ? error.message : String(error),
      );
      logger?.warn(undefined, "legacy zcode import failed; rolling back", {
        code: importError.code,
        message: importError.message,
        createdCount: created.length,
        stoppedInLegacy: Boolean(stopState),
      });
      // 回滚顺序：先逐字节还原源侧停止写（若有），再清新根半成品。备份文件保留作证据。
      if (stopState) {
        await atomicWritePrivateTextFile(sourceBindingsPath, stopState.originalContent).catch(() => {});
      }
      await rollbackTarget();
      throw importError;
    }
  }

  return { detect, importBindings };
}

/** 用户明确拒绝导入时的一次性标记（本产品数据根内；内容 = ISO 时间戳）。 */
export async function writeLegacyImportDeclinedMarker(
  targetRootDir: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const markerDir = join(targetRootDir, "raft");
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(markerDir, "legacy-import-declined"),
    `${now().toISOString()}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
