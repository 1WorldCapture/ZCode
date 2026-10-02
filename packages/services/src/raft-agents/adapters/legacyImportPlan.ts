/**
 * 导入计划构建（legacyImport 的规模拆分）：按 agentHomeKind 对每条源绑定做 Home
 * 归属分类，产出「可导入清单 + 归属不明跳过清单」。判定规则见 agentHomeKind.ts
 * （位置主判据 + `.zcode-agent-home` 标记一致性校验；容器名是预派发 UUID ≠ bindingId，
 * PM 修法四条）；本文件不做任何文件系统写入。
 */
import type { RaftAgentBinding } from "@zcode/shared";

import { resolveAgentHomeKind } from "./agentHomeKind.js";

export interface LegacyImportBindingPreview {
  bindingId: string;
  displayName: string;
  profileSlug: string;
  desiredState: RaftAgentBinding["desiredState"];
  /** default = 旧根 agents/<容器>/workspace（随导入复制）；custom = 用户自选目录（保留原路径，不复制）。 */
  homeKind: "default" | "custom";
  homeWorkspacePath: string;
}

/** Home 归属不明被拒绝导入的绑定（预览可见，让人能查明原因）。 */
export interface LegacyImportSkippedBinding {
  bindingId: string;
  displayName: string;
  reason: "unknown-home";
  detail: string;
}

/** 复制单元清单 → 实际复制路径（失败回滚与 mkdir 都以它为界）。 */
export interface ImportPlanEntry {
  binding: RaftAgentBinding;
  preview: LegacyImportBindingPreview;
  home:
    | { kind: "default"; sourceHomePath: string; containerDirName: string }
    | { kind: "custom" };
}

export interface ImportPlan {
  entries: ImportPlanEntry[];
  skipped: LegacyImportSkippedBinding[];
}

/** Home 分类（agentHomeKind：位置主判据 + 归属标记校验）；unknown-home 跳过该绑定。 */
export async function buildPlan(
  sourceRootDir: string,
  bindings: RaftAgentBinding[],
): Promise<ImportPlan> {
  const entries: ImportPlanEntry[] = [];
  const skipped: LegacyImportSkippedBinding[] = [];
  for (const binding of bindings) {
    const resolution = await resolveAgentHomeKind({
      dataRootDir: sourceRootDir,
      bindingId: binding.bindingId,
      homeWorkspacePath: binding.homeWorkspacePath,
    });
    if (resolution.kind === "unknown-home") {
      skipped.push({
        bindingId: binding.bindingId,
        displayName: binding.displayName,
        reason: "unknown-home",
        detail: resolution.detail,
      });
      continue;
    }
    entries.push({
      binding,
      preview: {
        bindingId: binding.bindingId,
        displayName: binding.displayName,
        profileSlug: binding.profileSlug,
        desiredState: binding.desiredState,
        homeKind: resolution.kind,
        homeWorkspacePath: binding.homeWorkspacePath,
      },
      home:
        resolution.kind === "default"
          ? {
              kind: "default",
              sourceHomePath: resolution.homeRealPath,
              containerDirName: resolution.containerDirName,
            }
          : { kind: "custom" },
    });
  }
  return { entries, skipped };
}
