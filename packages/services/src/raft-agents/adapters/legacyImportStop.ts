/**
 * 源侧停止写——整个导入器**唯一允许写旧产品数据的动作**（PM 硬要求），独立成模块
 * 便于审计：写前再探（ZCode 主进程 + 各绑定值守锁，grokbot 复核 2）→ 时间戳备份
 * （原内容逐字节、独占创建、保 mode）→ 锁内原子改写 imported ids 的
 * desiredState=ReadyStopped → 重读校验（数量/顺序/停到位/**除 desiredState/updatedAt
 * 外逐字段深比较**，grokbot 复核 3）→ 失败用原文还原。
 *
 * withFileLock 与 ZCode bindingStore 同协议（源产品若恰在此刻启动，锁防交错；锁目录
 * 瞬时存在，释放即清）。返回原始内容供调用方在后续步骤失败时逐字节还原。
 */
import { isDeepStrictEqual } from "node:util";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { raftAgentsConfigFileSchema, type RaftAgentBinding } from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

import { LegacyImportError } from "./legacyImportCopy.js";
import { probeLegacyWatchHeld, probeLegacyZCodeAppRunning } from "./legacyWatchProbe.js";

/** 停止写只允许动 desiredState / updatedAt；校验时剥掉这两个字段后深比较其余全部。 */
function stripMutableFields(binding: RaftAgentBinding): Omit<RaftAgentBinding, "desiredState" | "updatedAt"> {
  const { desiredState: _desiredState, updatedAt: _updatedAt, ...rest } = binding;
  return rest;
}

export async function stopLegacyWatch(input: {
  sourceBindingsPath: string;
  importedIds: Set<string>;
  now: () => Date;
  /** 写前 ZCode 主进程探测；缺省真实探测（SingletonLock），测试注入 stub。 */
  probeLegacyAppRunning?: () => Promise<boolean>;
  /** 测试注入：替换原子写实现（构造写后校验失败场景）。缺省 atomicWritePrivateTextFile。 */
  writeBindingsFile?: (path: string, content: string) => Promise<void>;
}): Promise<{ backupPath: string; originalContent: string }> {
  const { sourceBindingsPath, importedIds, now } = input;
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const backupFile = join(
    dirname(sourceBindingsPath),
    `bindings.json.pre-tinycode-import-${timestamp}`,
  );
  const writeBindingsFile =
    input.writeBindingsFile ??
    ((path: string, content: string) => atomicWritePrivateTextFile(path, content));
  return withFileLock(sourceBindingsPath, async () => {
    // 写前再探（grokbot 复核 2）：detect 到此处隔了整个复制过程。任一命中即中止——
    // 此时备份未写、原文件未动，调用方回滚只需清目标半成品。
    if (await (input.probeLegacyAppRunning ?? probeLegacyZCodeAppRunning)()) {
      throw new LegacyImportError(
        "legacy-app-running",
        "ZCode app is running; refusing to write legacy stop state",
      );
    }
    const legacyRootDir = dirname(dirname(sourceBindingsPath));
    for (const bindingId of importedIds) {
      if (await probeLegacyWatchHeld(legacyRootDir, bindingId)) {
        throw new LegacyImportError(
          "legacy-watch-held",
          `legacy watch lock re-acquired during import: ${bindingId}`,
        );
      }
    }
    const original = await readFile(sourceBindingsPath, "utf8");
    const parsed = raftAgentsConfigFileSchema.parse(JSON.parse(original));
    const updatedAt = now().toISOString();
    const next = {
      version: parsed.version,
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
      await writeBindingsFile(sourceBindingsPath, `${JSON.stringify(next, null, 2)}\n`);
      // 写后校验：重读 + schema + 停到位 + 其余字段一个字节不动（深比较）。
      const verify = raftAgentsConfigFileSchema.parse(
        JSON.parse(await readFile(sourceBindingsPath, "utf8")),
      );
      if (verify.version !== parsed.version) {
        throw new LegacyImportError("verify-failed", "legacy stop verify: version changed");
      }
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
        if (!isDeepStrictEqual(stripMutableFields(before), stripMutableFields(after))) {
          throw new LegacyImportError(
            "verify-failed",
            `legacy stop verify: unexpected field changes in ${after.bindingId}`,
          );
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
