// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * profile 目录的安静清理：接入失败路径（登录成功后任一步失败）与绑定移除共用。
 * 清理失败只记日志，不掩盖调用方的原始错误码；profile 目录从
 * <dataRootDir>/raft/profiles 下派生。
 */
import { join } from "node:path";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import type { RaftCliPort } from "./ports.js";

export interface ProfileCleanupDeps {
  cli: Pick<RaftCliPort, "destroyProfile">;
  /** 应用数据根（<ZCodeDataRoot>）。 */
  dataRootDir: string;
  logger?: ServiceLogger;
}

export async function cleanupProfileQuietly(deps: ProfileCleanupDeps, profileDir: string): Promise<void> {
  try {
    await deps.cli.destroyProfile({
      profileDir,
      profilesRoot: join(deps.dataRootDir, "raft", "profiles"),
    });
  } catch (error) {
    deps.logger?.warn(undefined, "profile cleanup left residue", {
      profileSlugPath: profileDir,
      error: String(error),
    });
  }
}
