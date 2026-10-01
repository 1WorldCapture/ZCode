/**
 * 接入向导的纯逻辑（与 React 解耦，供组件与单测共用；SPEC「二期 A2」）。
 *
 * 只含步骤校验与 createBinding 输入构造——不涉及任何服务调用与凭据存储。
 * token 只在这份草稿里短暂存在，构造输入后被组件立即清掉。
 */
import type { IRaftAgentsService } from "@zcode/services";
import type { RaftAgentSetupErrorCode } from "@/agents/types.js";

export const WIZARD_STEP_COUNT = 4;
export type WizardStep = 0 | 1 | 2 | 3;

/** 向导草稿：状态只活在组件生命周期内（SPEC 不变量：不持久化）。 */
export interface WizardDraft {
  raftOrigin: string;
  raftAgentId: string;
  token: string;
  homeWorkspacePath: string;
  /** 复用模式为所选凭据 slug，null 表示新 token 直传。 */
  reuseSlug: string | null;
}

export type ConnectInput = Parameters<IRaftAgentsService["createBinding"]>[0];

/**
 * 指定步骤点「下一步」时的校验：返回 i18n 文案 id（校验失败）或 null（可推进）。
 * 第 2→3 步（Home 路径）无必填约束，恒 null。
 */
export function draftErrorId(draft: WizardDraft, step: WizardStep): string | null {
  switch (step) {
    case 0:
      return draft.raftOrigin.trim()
        ? null
        : "agentCenter.wizard.error.originRequired";
    case 1:
      // 复用模式身份沿原凭据，无需填写 Agent ID / token。
      return !draft.reuseSlug && (!draft.raftAgentId.trim() || !draft.token.trim())
        ? "agentCenter.wizard.error.identityRequired"
        : null;
    default:
      return null;
  }
}

/**
 * 确认页显示并提交的 Home 路径：核验成功用服务端值（输入了就回显，留空是
 * 服务端预派发默认——与 createBinding 同一派生函数，不会漂移），核验前/失败
 * 或复用模式（UI 无 token 不能预核验）退回用户输入。
 */
export function resolveEffectiveHomePath(
  homeWorkspacePath: string,
  verifiedHomePath: string | null,
): string {
  return verifiedHomePath ?? homeWorkspacePath.trim();
}

/**
 * 构造 createBinding 输入：token 直传与 existingProfileSlug 复用互斥
 * （SPEC「二期 A2」，a517415a 线程定稿）。Home 路径把确认页显示的实际值
 * 显式回传（A2/B1 验收：两侧共用同一派生函数）；复用模式留空仍走服务端默认。
 */
export function buildConnectInput(draft: WizardDraft & { effectiveHomePath?: string }): ConnectInput {
  const homeWorkspacePath = (draft.effectiveHomePath ?? draft.homeWorkspacePath).trim();
  const base = {
    raftOrigin: draft.raftOrigin.trim(),
    raftAgentId: draft.raftAgentId.trim(),
    ...(homeWorkspacePath ? { homeWorkspacePath } : {}),
  };
  return draft.reuseSlug !== null
    ? { ...base, existingProfileSlug: draft.reuseSlug }
    : { ...base, token: draft.token };
}

/**
 * 每个接入错误码对应一条用户可理解的文案（穷尽：新增错误码会在这里编译报错）。
 * 提交（submitError）与第 4 步核验（verifyError）两个出口共用，不允许原始错误码上屏
 * （R3 缺陷修复）。
 */
export function setupErrorMessageId(code: RaftAgentSetupErrorCode): string {
  switch (code) {
    case "CliMissing":
    case "CliVersionUnsupported":
    case "OriginInvalid":
    case "AgentIdInvalid":
    case "TokenInvalid":
    case "IdentityMismatch":
    case "CredentialCheckFailed":
    case "PathConflict":
    case "HomeOverlapsCredentials":
    case "SlugConflict":
    case "AlreadyBound":
    case "ProvisioningFailed":
    case "StoreWriteFailed":
    case "ProfileInUse":
      return `agentCenter.form.error.${code}`;
  }
}

/**
 * Occupier names for the credential reuse list (R7): bindingId → displayName
 * from the same list() projection the Agent center already shows. The wizard
 * joins this with a credential's boundBindingId so a disabled entry can say
 * WHO occupies it instead of a generic "already used" line. Missing names
 * (list failed) fall back to the generic copy at the call site.
 */
export function buildOccupiedBindingNames(
  items: ReadonlyArray<{ bindingId: string; displayName: string }>,
): Map<string, string> {
  return new Map(items.map((item) => [item.bindingId, item.displayName]));
}
