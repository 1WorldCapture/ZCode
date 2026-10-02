/**
 * TinyCode 首启存量导入确认（task #28 PM 决定③ + 硬要求；grokbot 九条三道保险之一）。
 *
 * 仅 TinyCode 形态生效：在首个 Host 进程创建之前运行——导入的 desiredState=Running
 * 绑定要靠 Host 启动恢复链自动值守（验收 D8），所以这一步必须在主窗口/Host 之前完成。
 * 系统原生对话框（v1 不依赖 renderer 排期）：双消费警告 + 默认勾选「同时在 ZCode 中
 * 把这几个 agent 设为停止」（唯一允许写 ZCode 数据的动作）+ 重新登录说明 + 备份说明。
 * 用户拒绝只写本产品数据根内的一次性标记（legacy-import-declined），不再打扰。
 */
import { dialog } from "electron";
import { join } from "node:path";

import {
  createLegacyZCodeImporter,
  getDataBaseDir,
  getZCodeDataRootDir,
  writeLegacyImportDeclinedMarker,
  LEGACY_ZCODE_DATA_ROOT_NAME,
  type LegacyImportDetection,
} from "@zcode/services/node";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";

interface Logger {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const MESSAGES = {
  "zh-CN": {
    title: "从 ZCode 导入 Raft Agent",
    intro: (count: number, names: string) =>
      `检测到本机 ZCode 中有 ${count} 个 Raft Agent 绑定（${names}）。是否将它们导入 TinyCode？`,
    detail:
      "将复制：绑定记录、Raft 凭据（无需重新输入 token）、Agent 记忆与工作区、收件日志。\n" +
      "不会迁移：会话历史（从新会话开始）、账号登录态（首次使用需重新登录 Z.AI 账号）。\n" +
      "ZCode 中原有数据不会被删除或移动。\n\n" +
      "⚠ 双消费警告：ZCode 与 TinyCode 同时值守同一 agent 会争抢消息处理。建议勾选下方选项，" +
      "导入时把 ZCode 侧这几个 agent 的期望状态改为「停止」（只改这一项，修改前会在原目录自动备份，" +
      "其余数据不动）。",
    customHomeNote: (count: number) =>
      `其中 ${count} 个绑定使用自定义工作区目录：该目录不复制、由 ZCode 与 TinyCode 共用；` +
      "在 TinyCode 中删除这些绑定时也不会删除该目录。",
    skippedNote: (count: number) =>
      `另有 ${count} 个绑定因 Home 归属标记与绑定不匹配未导入（Home 无法确认属于该绑定），可在 ZCode 中查看。`,
    appRunning:
      "检测到 ZCode 正在运行。为避免两边同时值守，请先退出 ZCode，再重新打开 TinyCode 完成导入。\n" +
      "（本次未做任何更改；退出 ZCode 后重开 TinyCode 会再次提示。）",
    checkbox: "同时在 ZCode 中将这些 agent 设为停止（推荐）",
    confirm: "导入",
    cancel: "暂不导入",
    success: (count: number, stopped: boolean, skipped: number) =>
      `已导入 ${count} 个绑定。${stopped ? "ZCode 侧值守已停止（原 bindings.json 已备份）。" : ""}记得稍后在 ZCode 中手动停止这些 agent 的值守。` +
      (skipped > 0 ? `\n另有 ${skipped} 个绑定因归属不明未导入。` : ""),
    declined: "已跳过导入。之后可随时在 ZCode 中查看这些 agent。",
    failed: "导入未完成，未产生任何更改。",
  },
  "en-US": {
    title: "Import Raft Agents from ZCode",
    intro: (count: number, names: string) =>
      `Found ${count} Raft agent binding(s) in ZCode on this machine (${names}). Import them into TinyCode?`,
    detail:
      "Copies: bindings, Raft credentials (no token re-entry), agent memory and workspace, inbox logs.\n" +
      "Not migrated: conversation history (agents start fresh), account login state (sign in to your Z.AI account again on first use).\n" +
      "Nothing in ZCode is deleted or moved.\n\n" +
      "⚠ Dual-consumer warning: ZCode and TinyCode watching the same agent will race over messages. " +
      "Keep the option below checked to set those agents to stopped in ZCode (only the desired state changes; " +
      "the original file is backed up in place first).",
    customHomeNote: (count: number) =>
      `${count} of them use a custom workspace directory: it is not copied and is shared by ZCode and TinyCode; ` +
      "deleting those bindings in TinyCode will not delete the directory either.",
    skippedNote: (count: number) =>
      `${count} other binding(s) were not imported because the home ownership marker does not match the binding; check them in ZCode.`,
    appRunning:
      "ZCode appears to be running. To avoid both apps watching the same agents, quit ZCode first, then reopen TinyCode to import.\n" +
      "(Nothing was changed; TinyCode will offer the import again after ZCode quits.)",
    checkbox: "Also set these agents to stopped in ZCode (recommended)",
    confirm: "Import",
    cancel: "Not now",
    success: (count: number, stopped: boolean, skipped: number) =>
      `Imported ${count} binding(s). ${stopped ? "ZCode-side watching was stopped (original bindings.json backed up)." : "Remember to stop these agents in ZCode later."}` +
      (skipped > 0 ? `\n${skipped} binding(s) skipped due to unknown home ownership.` : ""),
    declined: "Import skipped. The agents remain available in ZCode.",
    failed: "Import did not complete; nothing was changed.",
  },
} as const;

function messagesFor(locale: string) {
  return locale.toLowerCase().startsWith("zh") ? MESSAGES["zh-CN"] : MESSAGES["en-US"];
}

export interface LegacyImportOfferOptions {
  locale: string;
  logger: Logger;
}

/**
 * 一次性导入提议。flavor 非 tinycode、检测不可用、或用户拒绝时静默返回；
 * 任何失败都不阻断启动（导入器自身保证回滚后零残留）。
 */
export async function maybeOfferLegacyZCodeImport(
  options: LegacyImportOfferOptions,
): Promise<void> {
  if (ZCODE_PRODUCT_FLAVOR !== "tinycode") return;
  const m = messagesFor(options.locale);
  // 旧根与目标根共用同一 base（自定义数据目录时两侧也在同一 base 下并排）。
  const sourceRootDir = join(getDataBaseDir(), LEGACY_ZCODE_DATA_ROOT_NAME);
  const targetRootDir = getZCodeDataRootDir();
  const importer = createLegacyZCodeImporter({ sourceRootDir, targetRootDir });

  let detection: LegacyImportDetection;
  try {
    detection = await importer.detect();
  } catch (error) {
    options.logger.warn("[legacy-import] detection failed:", error);
    return;
  }
  if (detection.status !== "available") {
    if (detection.reason === "legacy-app-running") {
      // 前置条件不满足（非用户拒绝）：明确告知退出 ZCode 后重来，不写 declined 标记。
      options.logger.info("[legacy-import] offer blocked: ZCode app is running");
      await dialog.showMessageBox({
        type: "info",
        message: m.title,
        detail: m.appRunning,
        buttons: ["OK"],
        noLink: true,
      });
      return;
    }
    // already-declined / target-not-empty / source-missing 都是常态，不打扰日志。
    if (
      detection.reason !== "source-missing" &&
      detection.reason !== "no-bindings" &&
      detection.reason !== "already-declined" &&
      detection.reason !== "target-not-empty"
    ) {
      options.logger.info("[legacy-import] offer skipped:", detection.reason, detection.detail ?? "");
    }
    return;
  }

  const names = detection.preview.bindings.map((b) => b.displayName).join("、");
  const customHomeCount = detection.preview.bindings.filter((b) => b.homeKind === "custom").length;
  const skippedCount = detection.preview.skipped.length;
  const detailParts = [
    m.intro(detection.preview.bindings.length, names),
    m.detail,
    ...(customHomeCount > 0 ? [m.customHomeNote(customHomeCount)] : []),
    ...(skippedCount > 0 ? [m.skippedNote(skippedCount)] : []),
  ];
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "question",
    title: m.title,
    message: m.title,
    detail: detailParts.join("\n\n"),
    checkboxLabel: m.checkbox,
    checkboxChecked: true,
    buttons: [m.confirm, m.cancel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response !== 0) {
    try {
      await writeLegacyImportDeclinedMarker(targetRootDir);
    } catch (error) {
      options.logger.warn("[legacy-import] failed to persist decline marker:", error);
    }
    options.logger.info("[legacy-import] user declined legacy import");
    return;
  }

  try {
    const result = await importer.importBindings({ stopLegacyBindings: checkboxChecked });
    options.logger.info("[legacy-import] import completed:", {
      importedCount: result.importedCount,
      stoppedInLegacy: result.stoppedInLegacy,
      backupPath: result.backupPath,
      skippedHomeCount: result.skippedHomeBindings.length,
      warningCount: result.warnings.length,
    });
    await dialog.showMessageBox({
      type: "info",
      message: m.title,
      detail:
        m.success(result.importedCount, result.stoppedInLegacy, result.skippedHomeBindings.length) +
        (result.warnings.length > 0 ? `\n\n${result.warnings.join("\n")}` : ""),
      buttons: ["OK"],
      noLink: true,
    });
  } catch (error) {
    options.logger.error("[legacy-import] import failed (rolled back):", error);
    await dialog.showMessageBox({
      type: "error",
      message: m.title,
      detail: `${m.failed}\n\n${error instanceof Error ? error.message : String(error)}`,
      buttons: ["OK"],
      noLink: true,
    });
  }
}
