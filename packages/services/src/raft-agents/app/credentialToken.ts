/**
 * 凭据 token 来源解析（grokbot e5addb16 / PM d764ceb9）：核验（verifyCredential）
 * 与接入（createBinding）共用的二选一规则——直传 token，或按 existingProfileSlug
 * 从本机凭据文件读出（读完即弃，用户 profile 不动）。抽出来收敛，两边规则不再
 * 各改各的。
 *
 * 安全不变量：token 只在本进程内流转，直达官方 CLI 的 stdin；不进日志、
 * RPC 返回值、事件与持久化结构。
 */
import type { RaftBindingStorePort, RaftProfilesCatalogPort } from "./ports.js";

/** 二选一入参（宽松形：token 优先，否则要求 existingProfileSlug；与 shared 侧 schema 同构）。 */
export type RaftCredentialTokenSource = {
  token?: string | undefined;
  existingProfileSlug?: string | undefined;
};

export type RaftCredentialTokenResolution =
  | { ok: true; token: string }
  | { ok: false; code: "ProfileInUse" | "CredentialCheckFailed" | "TokenInvalid"; detail?: string };

export async function resolveCredentialToken(
  deps: { store: RaftBindingStorePort; profilesCatalog?: RaftProfilesCatalogPort },
  source: RaftCredentialTokenSource,
): Promise<RaftCredentialTokenResolution> {
  let token = source.token?.trim();
  if (token === undefined) {
    const slug = source.existingProfileSlug;
    if (slug === undefined) {
      return { ok: false, code: "CredentialCheckFailed", detail: "token or existingProfileSlug required" };
    }
    // 占用早失败：确认页/接入表单不该走到保存阶段才报 ProfileInUse。
    const occupiedBy = (await deps.store.readAll()).find((b) => b.profileSlug === slug);
    if (occupiedBy) {
      return { ok: false, code: "ProfileInUse", detail: occupiedBy.displayName };
    }
    if (!deps.profilesCatalog) {
      return { ok: false, code: "CredentialCheckFailed", detail: "credential reuse not wired" };
    }
    const resolved = await deps.profilesCatalog.resolveProfileToken({ profileSlug: slug });
    if (!resolved.ok) {
      return { ok: false, code: "CredentialCheckFailed", detail: resolved.code };
    }
    token = resolved.token.trim();
  }
  if (!/^sk_agent_[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, code: "TokenInvalid" };
  }
  return { ok: true, token };
}
