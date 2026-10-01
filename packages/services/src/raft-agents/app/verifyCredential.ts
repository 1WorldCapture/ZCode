/**
 * verifyCredential（从 raftAgentsService 整函数搬出，行为不变）：向导确认页的预核验。
 * 与 createBinding 同族的本地前置校验 → 凭据 token 二选一 → 临时 verify- profile 登录核验。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  raftAgentIdSchema,
  type RaftAgentVerifyCredentialInput,
  type RaftAgentVerifyResult,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

import { normalizeHomePathForCompare, normalizeRaftOrigin } from "../domain/binding.js";
import { defaultRaftAgentHomePath } from "./bindingCreate.js";
import { resolveCredentialToken } from "./credentialToken.js";
import { loginAndVerifyIdentity } from "./loginVerify.js";
import type { RaftBindingStorePort, RaftCliPort, RaftProfilesCatalogPort } from "./ports.js";

export interface VerifyCredentialDeps {
  cli: RaftCliPort;
  store: RaftBindingStorePort;
  profilesCatalog?: RaftProfilesCatalogPort;
  dataRootDir: string;
  logger: ServiceLogger;
}

export async function verifyRaftCredential(
  deps: VerifyCredentialDeps,
  input: RaftAgentVerifyCredentialInput,
): Promise<RaftAgentVerifyResult> {
  const { cli, store, dataRootDir } = deps;
  const win32 = process.platform === "win32";
  const log = deps.logger;
  // 与 createBinding 同族的本地前置校验（无副作用、不打网络）。
  const origin = normalizeRaftOrigin(input.raftOrigin);
  if (origin === undefined) return { ok: false, code: "OriginInvalid" };
  const agentId = input.raftAgentId.trim();
  if (!raftAgentIdSchema.safeParse(agentId).success) {
    return { ok: false, code: "AgentIdInvalid" };
  }
  // 凭据来源二选一：与 createBinding 共用 resolveCredentialToken（同一条规则，
  // 不各改各的）。核验统一走临时 verify- profile 链，用户 profile 不被触碰
  // ——两种接入模式的确认页都能先核验身份再显示（线程 bbb29be1）。
  const credential = await resolveCredentialToken(
    { store, profilesCatalog: deps.profilesCatalog },
    input,
  );
  if (!credential.ok) {
    return { ok: false, code: credential.code, detail: credential.detail };
  }
  const token = credential.token;
  // 实际生效 Home（评审线程 a517415a，B1/A2 验收）：输入给了就按创建同款规则
  // 校验后回显；留空给预派发默认——绑定 UUID 创建时才生成，这里先派发一个
  // 具体路径，向导保存时作为显式输入回传（与创建共用 defaultRaftAgentHomePath）。
  let homePath: string;
  if (input.homeWorkspacePath !== undefined) {
    if (normalizeHomePathForCompare(input.homeWorkspacePath, { win32 }) === undefined) {
      return {
        ok: false,
        code: "OriginInvalid",
        detail: "homeWorkspacePath must be an absolute path",
      };
    }
    homePath = input.homeWorkspacePath;
  } else {
    homePath = defaultRaftAgentHomePath(dataRootDir, randomUUID());
  }
  const resolution = await cli.resolve();
  if (!resolution.ok) {
    return { ok: false, code: resolution.code, detail: resolution.detail };
  }
  // 临时 profile：verify- 前缀不进 listLocalCredentials 枚举；任何出口都即毁，
  // 无持久残留。登录→whoami→身份核验与 createBinding 共用一条链（复用审核 #11）。
  const profileSlug = `verify-${randomUUID().slice(0, 8)}`;
  const outcome = await loginAndVerifyIdentity(
    { cli, dataRootDir: dataRootDir, logger: log },
    {
      origin,
      expectedAgentId: agentId,
      profileSlug,
      profileDir: join(dataRootDir, "raft", "profiles", profileSlug),
      token,
      keepProfileOnSuccess: false,
    },
  );
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    homePath,
    identity: {
      agentId: outcome.agentId,
      ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
      serverUrl: outcome.serverUrl,
      serverId: outcome.serverId,
    },
  };
}
