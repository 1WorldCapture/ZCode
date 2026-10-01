/**
 * 接入向导的纯逻辑（与 React 解耦，供组件与单测共用；SPEC「二期 A2」）。
 *
 * 只含步骤校验与 createBinding 输入构造——不涉及任何服务调用与凭据存储。
 * token 只在这份草稿里短暂存在，构造输入后被组件立即清掉。
 */
import type { IRaftAgentsService } from "@zcode/services";

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
 * 构造 createBinding 输入：token 直传与 existingProfileSlug 复用互斥
 * （SPEC「二期 A2」，a517415a 线程定稿）。Home 路径留空不下发，用服务端默认。
 */
export function buildConnectInput(draft: WizardDraft): ConnectInput {
  const base = {
    raftOrigin: draft.raftOrigin.trim(),
    raftAgentId: draft.raftAgentId.trim(),
    ...(draft.homeWorkspacePath.trim()
      ? { homeWorkspacePath: draft.homeWorkspacePath.trim() }
      : {}),
  };
  return draft.reuseSlug !== null
    ? { ...base, existingProfileSlug: draft.reuseSlug }
    : { ...base, token: draft.token };
}
