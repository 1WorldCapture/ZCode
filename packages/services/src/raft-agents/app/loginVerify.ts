// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 登录→whoami→身份核验共用链（复用审核 #11：此前 verifyCredential 与
 * createBinding 各持一份原样重复的实现）。
 *
 * 返回口径与两侧原有语义一致：login 失败透传 CLI 错误码；whoami 失败
 * CredentialCheckFailed；身份不一致（agentId 或 origin）IdentityMismatch。
 * 统一后的刻意收严：登录失败也清理 profile（原 createBinding 不清，残留即毁更安全，
 * destroyProfile 对不存在的目录是幂等 no-op）。keepProfileOnSuccess=false 供凭据
 * 预核验的临时 profile：成功后同样即毁，任何出口无持久残留。
 *
 * 安全不变量：token 只经此处直达官方 CLI 的 stdin，不进日志、返回值与事件。
 */
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import { normalizeRaftOrigin } from "../domain/binding.js";
import type { RaftCliPort } from "./ports.js";
import { cleanupProfileQuietly } from "./profileCleanup.js";

export type RaftLoginVerifyOutcome =
  | { ok: true; agentName?: string; agentId: string; serverUrl: string; serverId: string }
  | {
      ok: false;
      code: "TokenInvalid" | "IdentityMismatch" | "CredentialCheckFailed";
      detail?: string;
    };

export async function loginAndVerifyIdentity(
  deps: { cli: RaftCliPort; dataRootDir: string; logger?: ServiceLogger },
  params: {
    origin: string;
    expectedAgentId: string;
    profileSlug: string;
    profileDir: string;
    /** 只进官方 CLI 的 stdin：不进日志、返回值与调用链之外的任何结构。 */
    token: string;
    /** false = 临时 profile（预核验）：成功后即毁；true = 绑定 profile：成功保留。 */
    keepProfileOnSuccess: boolean;
  },
): Promise<RaftLoginVerifyOutcome> {
  const cleanup = () => cleanupProfileQuietly(deps, params.profileDir);

  const login = await deps.cli.login({
    origin: params.origin,
    expectedAgentId: params.expectedAgentId,
    profileSlug: params.profileSlug,
    profileDir: params.profileDir,
    token: params.token,
  });
  if (!login.ok) {
    await cleanup();
    return { ok: false, code: login.code, detail: login.detail };
  }

  const whoami = await deps.cli.whoami({ profileSlug: params.profileSlug, profileDir: params.profileDir });
  if ("error" in whoami) {
    await cleanup();
    return { ok: false, code: "CredentialCheckFailed", detail: whoami.error };
  }
  const whoamiOrigin = normalizeRaftOrigin(whoami.serverUrl);
  if (whoami.agentId !== params.expectedAgentId || whoamiOrigin !== params.origin) {
    await cleanup();
    // 保持两侧原有形状：不带 detail 键（消费方按严格形状断言）。
    return { ok: false, code: "IdentityMismatch" };
  }
  if (!params.keepProfileOnSuccess) {
    await cleanup();
  }
  return {
    ok: true,
    agentId: whoami.agentId,
    agentName: login.agentName?.trim() || undefined,
    serverUrl: whoami.serverUrl,
    serverId: whoami.serverId,
  };
}
