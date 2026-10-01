/**
 * 本机凭据目录适配器（二期 A1）：枚举 raft/profiles 下各 profile 的 credential.json 的非敏感字段。
 *
 * 安全纪律（SPEC 二期 A1 / 安全红线）：
 * - apiKey 只在解析瞬间经过内存：list() 解构非敏感字段后即弃，永不进入返回结构、
 *   日志或上层调用方；resolveProfileToken 是唯一读出 token 的入口，仅供复用凭据
 *   接入链路直达官方 CLI stdin（与表单直传同链路）。
 * - slug 只接受 [a-z0-9][a-z0-9-]{0,63}，天然排除路径分隔与 ".."；目录解析后再做
 *   realpath 两侧包含判定（防符号链接把读取面引出 profilesRoot）。
 * - verify- 前缀目录是 verifyCredential 的临时核验工作区，不进枚举结果。
 */
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { isResolvedPathWithin } from "@zcode/shared/node";

import type { RaftLocalProfileEntry, RaftProfilesCatalogPort } from "../app/ports.js";

const PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERIFY_SLUG_PREFIX = "verify-";

/** credential.json 的最小结构面（与 raft CLI auth/env.ts 的 ProfileCredentialFile 对齐）。 */
interface ProfileCredentialFile {
  schemaVersion?: number;
  serverUrl: string;
  agentId: string;
  agentName?: string;
  serverId?: string | null;
  credentialId?: string;
  scopes?: string[];
  apiKey: string;
  createdAt?: string;
}

function parseCredential(raw: string): ProfileCredentialFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Partial<ProfileCredentialFile>;
  // 必填三字段（与 CLI 侧校验同口径）；apiKey 只做类型确认，值不外传。
  if (
    typeof candidate.serverUrl !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.apiKey !== "string"
  ) {
    return undefined;
  }
  return candidate as ProfileCredentialFile;
}

export function createRaftProfilesCatalog(profilesRoot: string): RaftProfilesCatalogPort {
  return {
    async list(): Promise<RaftLocalProfileEntry[]> {
      let entries;
      try {
        entries = await readdir(profilesRoot, { withFileTypes: true });
      } catch {
        return []; // 目录不存在 = 本机无凭据，合法空集
      }
      const found: RaftLocalProfileEntry[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!PROFILE_SLUG_PATTERN.test(entry.name)) continue;
        if (entry.name.startsWith(VERIFY_SLUG_PREFIX)) continue;
        let raw: string;
        try {
          raw = await readFile(join(profilesRoot, entry.name, "credential.json"), "utf8");
        } catch {
          continue; // 无 credential.json 的目录不是凭据（登录中断残留等），跳过
        }
        const credential = parseCredential(raw);
        if (!credential) continue;
        // 解构即弃：从这里开始只引用非敏感字段，apiKey 不再出现。
        const { serverUrl, agentId, agentName, serverId, createdAt } = credential;
        found.push({
          profileSlug: entry.name,
          serverUrl,
          serverId: serverId ?? "",
          agentId,
          ...(agentName !== undefined ? { agentName } : {}),
          createdAt: createdAt ?? "",
        });
      }
      found.sort((a, b) => a.profileSlug.localeCompare(b.profileSlug));
      return found;
    },

    async resolveProfileToken(params) {
      const slug = params.profileSlug;
      if (!PROFILE_SLUG_PATTERN.test(slug)) {
        return { ok: false, code: "Unreadable" };
      }
      let rootReal: string;
      try {
        rootReal = await realpath(profilesRoot);
      } catch {
        return { ok: false, code: "Missing" as const };
      }
      const profileDir = join(profilesRoot, slug);
      let dirReal: string;
      try {
        dirReal = await realpath(profileDir);
      } catch {
        return { ok: false, code: "Missing" as const };
      }
      if (!isResolvedPathWithin(dirReal, rootReal)) {
        return { ok: false, code: "Missing" as const };
      }
      let raw: string;
      try {
        raw = await readFile(join(dirReal, "credential.json"), "utf8");
      } catch {
        return { ok: false, code: "Missing" as const };
      }
      const credential = parseCredential(raw);
      if (!credential || credential.apiKey.length === 0) {
        return { ok: false, code: "Unreadable" as const };
      }
      // token 交调用方直达 CLI stdin；本适配器不落任何痕迹。
      return { ok: true, token: credential.apiKey };
    },
  };
}
