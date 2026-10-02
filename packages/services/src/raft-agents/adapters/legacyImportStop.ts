/**
 * 源侧停止写——整个导入器**唯一允许写旧产品数据的动作**（PM 硬要求），独立成模块
 * 便于审计：时间戳备份（原内容逐字节、独占创建、保 mode）→ 锁内原子改写 imported
 * ids 的 desiredState=ReadyStopped → 重读校验（数量/顺序/停到位）→ 失败用原文还原。
 *
 * withFileLock 与 ZCode bindingStore 同协议（源产品若恰在此刻启动，锁防交错；锁目录
 * 瞬时存在，释放即清）。返回原始内容供调用方在后续步骤失败时逐字节还原。
 */
import { lstat, readFile, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";

import { raftAgentsConfigFileSchema } from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

import { LegacyImportError } from "./legacyImportCopy.js";

export async function stopLegacyWatch(input: {
  sourceBindingsPath: string;
  importedIds: Set<string>;
  now: () => Date;
}): Promise<{ backupPath: string; originalContent: string }> {
  const { sourceBindingsPath, importedIds, now } = input;
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const backupFile = join(
    dirname(sourceBindingsPath),
    `bindings.json.pre-tinycode-import-${timestamp}`,
  );
  return withFileLock(sourceBindingsPath, async () => {
    const original = await readFile(sourceBindingsPath, "utf8");
    const parsed = raftAgentsConfigFileSchema.parse(JSON.parse(original));
    const updatedAt = now().toISOString();
    const next = {
      version: 1 as const,
      bindings: parsed.bindings.map((binding) =>
        importedIds.has(binding.bindingId)
          ? { ...binding, desiredState: "ReadyStopped" as const, updatedAt }
          : binding,
      ),
    };
    // 备份：同目录、原内容逐字节、独占创建、保 mode（cp 语义手工做，避免跟随行为）。
    const originalStat = await lstat(sourceBindingsPath);
    await writeFile(backupFile, original, { mode: originalStat.mode & 0o777, flag: "wx" });
    await chmod(backupFile, originalStat.mode & 0o777).catch(() => {});
    try {
      await atomicWritePrivateTextFile(
        sourceBindingsPath,
        `${JSON.stringify(next, null, 2)}\n`,
      );
      // 写后校验：重读 + schema + 只允许 desiredState/updatedAt 变化。
      const verify = raftAgentsConfigFileSchema.parse(
        JSON.parse(await readFile(sourceBindingsPath, "utf8")),
      );
      if (verify.bindings.length !== parsed.bindings.length) {
        throw new LegacyImportError("verify-failed", "legacy stop verify: binding count changed");
      }
      for (let i = 0; i < verify.bindings.length; i += 1) {
        const before = parsed.bindings[i]!;
        const after = verify.bindings[i]!;
        if (before.bindingId !== after.bindingId) {
          throw new LegacyImportError("verify-failed", "legacy stop verify: binding order changed");
        }
        if (importedIds.has(after.bindingId) && after.desiredState !== "ReadyStopped") {
          throw new LegacyImportError("verify-failed", `legacy stop verify: ${after.bindingId} not stopped`);
        }
      }
    } catch (error) {
      // 校验/写失败：用原始内容逐字节还原，再向上抛（导入整体回滚）。
      await atomicWritePrivateTextFile(sourceBindingsPath, original).catch(() => {});
      throw error;
    }
    return { backupPath: backupFile, originalContent: original };
  });
}
