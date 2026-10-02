// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 存量 ZCode 绑定只读导入器（TinyCode 首启；task #28 PM 决定③ + grokbot 九条/复核七条）。
 *
 * 职责：把旧产品数据根（`~/.zcode`）下的 Raft 接入事实复制到本产品数据根
 * （编译期 ZCODE_DATA_ROOT_NAME，TinyCode 构建为 `~/.tinycode`）：
 * - `raft/bindings.json`（改写 homeWorkspacePath / 清 mainSessionRef / 按勾选定 desiredState）
 * - `raft/profiles/<slug>/`（凭据 + agent-comms-core，整目录，保权限）
 * - `raft/agents/<容器>/workspace`（默认位置 Agent Home：记忆 + 归属标记；**容器名是
 *   预派发 UUID ≠ bindingId**，判定/复制/改写全部沿用原容器名——PM 修法四条）
 * - `raft/inbox-logs/<bindingId>/`（claim→落盘→ack 去重靠它，D8 语义）
 * 不迁：会话库（PM 决定②）、`raft/locks`（锁属进程实例）、账号登录态 credentials.json
 * （PM 决定：TinyCode 需重新登录）。
 *
 * 安全纪律（grokbot 九条 + PM 硬要求 + 复核 1–5/7）：
 * - 源侧探测/读取全程只读；唯一允许的源侧写 = 用户勾选「同时停止 ZCode 侧值守」时
 *   改写这几个绑定的 desiredState（legacyImportStop.ts，写前再探、备份、原子写、
 *   深比较校验、可还原）。
 * - ZCode 主进程在运行（SingletonLock）或绑定值守中（存活 pid 持锁）→ 拒绝导入；
 *   detect 面遇解析不了的锁同样按持有拒绝（启动门保持 fail-open）。
 * - Home 归属不明（位置是默认形态但 `.zcode-agent-home` 缺失/不符）→ 预览标出并
 *   拒绝导入该绑定（其余继续），绝不错配别人的 Home。
 * - 复制拒绝符号链接与非常规文件；文件保 mode（credential.json 0600）。
 * - 失败回滚只清本产品数据根内的半成品；源侧已做的停止写用备份逐字节还原。
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
  pathExists,
} from "./legacyImportCopy.js";
import {
  buildPlan,
  type ImportPlan,
  type LegacyImportBindingPreview,
  type LegacyImportSkippedBinding,
} from "./legacyImportPlan.js";
import { stopLegacyWatch } from "./legacyImportStop.js";
import { probeLegacyWatchHeld, probeLegacyZCodeAppRunning } from "./legacyWatchProbe.js";

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
  | "legacy-app-running"
  | "legacy-watch-held"
  | "all-unknown-home"
  | "already-declined";

// 预览/跳过条目类型在 legacyImportPlan.ts（buildPlan 与本文件共用），此处转出口供
// node.ts 与测试沿用单一 import 入口。
export type { LegacyImportBindingPreview, LegacyImportSkippedBinding };

export interface LegacyImportPreview {
  sourceRootDir: string;
  targetRootDir: string;
  bindings: LegacyImportBindingPreview[];
  skipped: LegacyImportSkippedBinding[];
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
  /** Home 归属不明而跳过的绑定（未导入、未写源侧）。 */
  skippedHomeBindings: LegacyImportSkippedBinding[];
  /** 非致命问题（如 profile 目录缺失）：导入完成但该绑定凭据会显示待核验。 */
  warnings: string[];
}

/** 目标绑定存储的最小结构（createRaftBindingStore 满足；测试注入失败实现）。 */
interface BindingStoreLike {
  readAll(): Promise<RaftAgentBinding[]>;
  writeAll(bindings: RaftAgentBinding[]): Promise<void>;
}

export interface LegacyZCodeImporterOptions {
  /** 旧产品数据根（如 ~/.zcode）。 */
  sourceRootDir: string;
  /** 本产品数据根（如 ~/.tinycode）。 */
  targetRootDir: string;
  logger?: ServiceLogger;
  /** 测试注入：时间戳。 */
  now?: () => Date;
  /** ZCode 主进程探测；缺省真实探测（SingletonLock），测试注入 stub。 */
  probeLegacyAppRunning?: () => Promise<boolean>;
  /** 测试注入：目标绑定存储工厂。缺省 createRaftBindingStore。 */
  createBindingStore?: (rootDir: string) => BindingStoreLike;
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

/** 复制单元清单 → 实际复制路径（失败回滚与 mkdir 都以它为界）。类型在 legacyImportPlan.ts。 */

export function createLegacyZCodeImporter(options: LegacyZCodeImporterOptions) {
  const sourceRootDir = resolve(options.sourceRootDir);
  const targetRootDir = resolve(options.targetRootDir);
  const logger = options.logger;
  const now = options.now ?? (() => new Date());
  const sourceBindingsPath = join(sourceRootDir, "raft", "bindings.json");
  const probeLegacyAppRunning = options.probeLegacyAppRunning ?? probeLegacyZCodeAppRunning;
  const createBindingStore = options.createBindingStore ?? createRaftBindingStore;

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
    // ZCode 主进程在运行 → 拒绝（内存态写回会覆盖停止值；D6 退避也会重新拉起 bridge）。
    if (await probeLegacyAppRunning()) {
      return { status: "not-available", reason: "legacy-app-running" };
    }
    const heldBindingIds: string[] = [];
    for (const binding of bindings) {
      // detect 面 fail-closed：锁目录在但 owner 解析不了 → 按持有拒绝。
      if (await probeLegacyWatchHeld(sourceRootDir, binding.bindingId, { unparsableAsHeld: true })) {
        heldBindingIds.push(binding.bindingId);
      }
    }
    if (heldBindingIds.length > 0) {
      return { status: "not-available", reason: "legacy-watch-held", detail: heldBindingIds.join(",") };
    }
    const plan = await buildPlan(sourceRootDir, bindings);
    if (plan.entries.length === 0 && plan.skipped.length > 0) {
      return {
        status: "not-available",
        reason: "all-unknown-home",
        detail: plan.skipped.map((s) => s.bindingId).join(","),
      };
    }
    return {
      status: "available",
      preview: {
        sourceRootDir,
        targetRootDir,
        bindings: plan.entries.map((entry) => entry.preview),
        skipped: plan.skipped,
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
    const plan = await buildPlan(sourceRootDir, sourceRead.bindings);
    if (plan.entries.length === 0) {
      throw new LegacyImportError("not-available", "no importable bindings (home ownership unknown)");
    }
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
      for (const entry of plan.entries) {
        const src = join(sourceRootDir, "raft", "profiles", entry.binding.profileSlug);
        if (!(await pathExists(src))) {
          warnings.push(`profile directory missing for slug ${entry.binding.profileSlug}`);
          continue;
        }
        await copyTreeInto(
          src,
          join(targetRootDir, "raft", "profiles", entry.binding.profileSlug),
          targetRootDir,
          created,
        );
      }
      // 2) 默认位置 Agent Home（custom Home 保留原绝对路径，不复制用户目录）。
      //    源与目标都沿用原容器名（UUID ≠ bindingId），与 ZCode 侧布局一一对应。
      for (const entry of plan.entries) {
        if (entry.home.kind !== "default") continue;
        if (!(await pathExists(entry.home.sourceHomePath))) {
          warnings.push(`agent home missing for ${entry.binding.bindingId}`);
          continue;
        }
        await copyTreeInto(
          entry.home.sourceHomePath,
          join(targetRootDir, "agents", entry.home.containerDirName, "workspace"),
          targetRootDir,
          created,
        );
      }
      // 3) inbox-logs（缺 = 正常，全新绑定从未值守过）。
      for (const entry of plan.entries) {
        const src = join(sourceRootDir, "raft", "inbox-logs", entry.binding.bindingId);
        if (!(await pathExists(src))) continue;
        await copyTreeInto(src, join(targetRootDir, "raft", "inbox-logs", entry.binding.bindingId), targetRootDir, created);
      }

      // 4) 源侧停止写（勾选时；内部写前再探，失败即整体回滚，含备份还原）。
      if (input.stopLegacyBindings) {
        stopState = await stopLegacyWatch({
          sourceBindingsPath,
          importedIds: new Set(plan.entries.map((entry) => entry.binding.bindingId)),
          now,
          probeLegacyAppRunning,
        });
      }

      // 5) 提交：目标 bindings.json（原子 + 锁内，bindingStore 语义）。
      const updatedAt = now().toISOString();
      const imported: RaftAgentBinding[] = plan.entries.map((entry) => ({
        ...entry.binding,
        homeWorkspacePath:
          entry.home.kind === "default"
            ? join(targetRootDir, "agents", entry.home.containerDirName, "workspace")
            : entry.binding.homeWorkspacePath,
        // 会话不迁移（PM 决定②）：引用指向 ZCode 侧会话库，必须清空。
        mainSessionRef: null,
        // 勾选停止 → 保留原 desiredState（旧侧已停，无双消费；Running 导入即恢复值守）。
        // 未勾选 → 一律置停止（grokbot 第 4 条：防两边同时值守）。
        desiredState: input.stopLegacyBindings ? entry.binding.desiredState : "ReadyStopped",
        updatedAt,
      }));
      const store = createBindingStore(targetRootDir);
      await store.writeAll(imported);
      created.push(join(targetRootDir, "raft", "bindings.json"));

      // 6) 终验：目标可解析且数量一致。
      const verify = await store.readAll();
      if (verify.length !== imported.length) {
        throw new LegacyImportError("verify-failed", "target binding count mismatch after import");
      }
      logger?.info(undefined, "legacy zcode import completed", {
        importedCount: imported.length,
        skippedHomeCount: plan.skipped.length,
        stoppedInLegacy: input.stopLegacyBindings,
        backupPath: stopState?.backupPath,
        warningCount: warnings.length,
      });
      return {
        importedCount: imported.length,
        stoppedInLegacy: input.stopLegacyBindings,
        ...(stopState ? { backupPath: stopState.backupPath } : {}),
        skippedHomeBindings: plan.skipped,
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
