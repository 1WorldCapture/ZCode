/**
 * 接入 Agent 四步向导（二期 A2，范围见 SPEC.md「二期 A2」）。
 *
 * 步骤：① 服务地址 ② 身份与凭据（新 token 或复用本机凭据）③ Home 路径 ④ 核验并确认。
 * 状态只存在于本组件生命周期内（SPEC 不变量：不持久化）；来回切换不丢已填内容。
 *
 * 第 4 步先调 verifyCredential 只核验不保存，展示服务端返回的身份供用户确认，
 * 确认后才 createBinding。向导任一提交点返回 CliMissing 时切换为安装命令提示
 * （占位文案，发布方式由 A3 给出后替换；向导不执行任何安装动作）。
 *
 * token 只存在于本组件的本次提交内：直传模式随提交结束即清，复用模式 UI 全程不接触。
 */
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import { submitConnect } from "@/agents/agentCenterActions.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";
import type { RaftAgentSetupErrorCode } from "@/agents/types.js";
import {
  buildConnectInput,
  draftErrorId,
  WIZARD_STEP_COUNT,
  type WizardStep,
} from "@/agents/agentConnectWizardModel.js";
import {
  StepConfirm,
  StepHomeForm,
  StepIdentityForm,
  StepServerForm,
  type CredentialItem,
  type VerifyIdentity,
} from "@/agents/AgentConnectWizardSteps.js";

/**
 * 安装命令（fork 构建的 CLI，经 fork 仓库 GitHub Release 发布，A3）。
 * 版本升级时地址会变化（raft-cli-vX.Y.Z-zcode.N），只改这一处。
 */
const CLI_INSTALL_COMMAND =
  "npm install -g https://github.com/1WorldCapture/raft-source/releases/download/raft-cli-v0.0.24-zcode.1/botiverse-raft-0.0.24-zcode.1.tgz";

/** 每个接入错误码对应一条用户可理解的文案（穷尽：新增错误码会在这里编译报错）。 */
function setupErrorMessageId(code: RaftAgentSetupErrorCode): string {
  switch (code) {
    case "CliMissing":
    case "CliVersionUnsupported":
    case "OriginInvalid":
    case "AgentIdInvalid":
    case "TokenInvalid":
    case "IdentityMismatch":
    case "CredentialCheckFailed":
    case "PathConflict":
    case "SlugConflict":
    case "AlreadyBound":
    case "ProvisioningFailed":
    case "StoreWriteFailed":
    case "ProfileInUse":
      return `agentCenter.form.error.${code}`;
  }
}

export function AgentConnectWizardPage() {
  const { intl } = useZCodeIntl();
  const backToList = useAgentCenterStore((state) => state.backToList);
  const service = useRaftAgentsService();
  const submitting = useAgentCenterStore((state) => state.submitting);
  const submitError = useAgentCenterStore((state) => state.submitError);

  // ── 向导状态（不持久化，组件卸载即清空）──
  const [step, setStep] = useState<WizardStep>(0);
  const [raftOrigin, setRaftOrigin] = useState("");
  const [raftAgentId, setRaftAgentId] = useState("");
  const [token, setToken] = useState("");
  const [homeWorkspacePath, setHomeWorkspacePath] = useState("");
  const [reuseSlug, setReuseSlug] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialItem[] | null>(null);
  const [credentialsFailed, setCredentialsFailed] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [cliMissing, setCliMissing] = useState(false);
  // 第 4 步：核验状态与结果。
  const [verifying, setVerifying] = useState(false);
  const [identity, setIdentity] = useState<VerifyIdentity | null>(null);
  const [verifyError, setVerifyError] = useState<RaftAgentSetupErrorCode | null>(null);

  // 进入第 2 步时拉取本机凭据列表（复用选择器数据源，A1 接口）。
  useEffect(() => {
    if (step !== 1 || !service || credentials !== null || credentialsFailed) return;
    let cancelled = false;
    service
      .listLocalCredentials()
      .then((list) => {
        if (!cancelled) setCredentials(list);
      })
      .catch((error) => {
        logger.warn("[AgentCenter] 本机凭据列表加载失败", { error });
        if (!cancelled) setCredentialsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [step, service, credentials, credentialsFailed]);

  if (!service) {
    return null;
  }

  const reuseMode = reuseSlug !== null;

  // 第 4 步展示的身份：新凭据模式取 verifyCredential 返回，复用模式取所选凭据
  // （身份沿原凭据，SPEC「二期 A2」）。两者形状一致（agentId/agentName?/serverUrl）。
  const selectedCredential =
    reuseSlug !== null
      ? (credentials ?? []).find((credential) => credential.profileSlug === reuseSlug)
      : undefined;
  const displayIdentity: VerifyIdentity | null = reuseMode
    ? (selectedCredential ?? null)
    : identity;

  const goBack = () => {
    setFieldError(null);
    setVerifyError(null);
    setStep((current) => Math.max(0, current - 1) as WizardStep);
  };

  const handleNext = () => {
    setFieldError(null);
    const errorId = draftErrorId(
      { raftOrigin, raftAgentId, token, homeWorkspacePath, reuseSlug },
      step,
    );
    if (errorId) {
      setFieldError(intl.formatMessage({ id: errorId }));
      return;
    }
    if (step === 2) {
      // 进入确认页：新凭据模式先调 verifyCredential 核验；复用模式的核验由
      // createBinding 内部的 login → whoami 承担（UI 手里没有 token，无法预核验）。
      setStep(3);
      if (!reuseMode) void runVerify();
      return;
    }
    setStep((current) => (current + 1) as WizardStep);
  };

  const runVerify = async () => {
    setVerifying(true);
    setVerifyError(null);
    setIdentity(null);
    try {
      const result = await service.verifyCredential({
        raftOrigin: raftOrigin.trim(),
        raftAgentId: raftAgentId.trim(),
        token,
      });
      if (!result.ok) {
        if (result.code === "CliMissing") {
          setCliMissing(true);
          return;
        }
        setVerifyError(result.code);
        return;
      }
      setIdentity(result.identity);
    } catch (error) {
      logger.warn("[AgentCenter] 身份核验失败", { error });
      setVerifyError("CredentialCheckFailed");
    } finally {
      setVerifying(false);
    }
  };

  const handleConfirm = () => {
    // 复用模式不下发 token，服务侧从既有 profile 读取（读取即弃，SPEC「二期 A2」）。
    const input = buildConnectInput({
      raftOrigin,
      raftAgentId,
      token,
      homeWorkspacePath,
      reuseSlug,
    });
    // 无论成功失败都立即清掉输入框里的 token，重试需要重新粘贴。
    setToken("");
    void submitConnect(service, input).then((ok) => {
      if (!ok && useAgentCenterStore.getState().submitError?.code === "CliMissing") {
        setCliMissing(true);
      }
    });
  };

  const selectCredential = (credential: CredentialItem) => {
    if (credential.boundBindingId) return; // 已被占用：置灰不可选（只沿原身份）。
    setReuseSlug(credential.profileSlug);
    setRaftOrigin(credential.serverUrl);
    setRaftAgentId(credential.agentId);
    setToken("");
    setIdentity(null);
    setVerifyError(null);
  };

  const switchToNewCredential = () => {
    setReuseSlug(null);
    setIdentity(null);
    setVerifyError(null);
  };

  const errorText =
    fieldError ??
    verifyError ??
    (submitError
      ? intl.formatMessage(
          { id: setupErrorMessageId(submitError.code) },
          { detail: submitError.detail ?? "" },
        )
      : null);

  // ── CLI 缺失：安装命令提示态（占位，不执行安装）──
  if (cliMissing) {
    return (
      <div className="flex h-full flex-col">
        <WizardHeader />
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-lg flex-col gap-4 py-8">
            <h2 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "agentCenter.wizard.cliMissing.title" })}
            </h2>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "agentCenter.wizard.cliMissing.description" })}
            </p>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-ui-sm text-foreground">
              <code>{CLI_INSTALL_COMMAND}</code>
            </pre>
            <p className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.wizard.cliMissing.versionNote" })}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={goBack}>
                {intl.formatMessage({ id: "agentCenter.wizard.back" })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <WizardHeader />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex max-w-lg flex-col gap-5 px-6 py-6">
          <WizardStepsBar current={step} />
          {errorText ? (
            <p className="text-ui-caption text-destructive" role="alert">
              {errorText}
            </p>
          ) : null}
          {step === 0 ? (
            <StepServerForm raftOrigin={raftOrigin} onRaftOriginChange={setRaftOrigin} />
          ) : null}
          {step === 1 ? (
            <StepIdentityForm
              raftAgentId={raftAgentId}
              token={token}
              reuseSlug={reuseSlug}
              credentials={credentials}
              credentialsFailed={credentialsFailed}
              onRaftAgentIdChange={setRaftAgentId}
              onTokenChange={setToken}
              onSelectCredential={selectCredential}
              onSwitchToNew={switchToNewCredential}
            />
          ) : null}
          {step === 2 ? (
            <StepHomeForm
              homeWorkspacePath={homeWorkspacePath}
              onHomeWorkspacePathChange={setHomeWorkspacePath}
            />
          ) : null}
          {step === 3 ? (
            <StepConfirm
              raftOrigin={raftOrigin.trim()}
              raftAgentId={raftAgentId.trim()}
              homeWorkspacePath={homeWorkspacePath.trim()}
              reuseMode={reuseMode}
              verifying={verifying}
              identity={displayIdentity}
            />
          ) : null}
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={verifying || submitting}
                onClick={goBack}
              >
                {intl.formatMessage({ id: "agentCenter.wizard.back" })}
              </Button>
            ) : null}
            {step < WIZARD_STEP_COUNT - 1 ? (
              <Button type="button" size="sm" disabled={verifying} onClick={handleNext}>
                {intl.formatMessage({ id: "agentCenter.wizard.next" })}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={verifying || submitting || !displayIdentity}
                onClick={handleConfirm}
              >
                {intl.formatMessage({
                  id: submitting
                    ? "agentCenter.form.saving"
                    : "agentCenter.wizard.step4.confirm",
                })}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={backToList}>
              {intl.formatMessage({ id: "agentCenter.wizard.cancel" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WizardHeader() {
  const { intl } = useZCodeIntl();
  const backToList = useAgentCenterStore((state) => state.backToList);
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={intl.formatMessage({ id: "agentCenter.backToList" })}
        onClick={backToList}
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
      </Button>
      <span className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "agentCenter.connect" })}
      </span>
    </div>
  );
}

function WizardStepsBar({ current }: { current: number }) {
  const { intl } = useZCodeIntl();
  const labels = [
    intl.formatMessage({ id: "agentCenter.wizard.step1.label" }),
    intl.formatMessage({ id: "agentCenter.wizard.step2.label" }),
    intl.formatMessage({ id: "agentCenter.wizard.step3.label" }),
    intl.formatMessage({ id: "agentCenter.wizard.step4.label" }),
  ];
  return (
    <ol className="flex flex-wrap items-center gap-1" data-testid="wizard-steps">
      {labels.map((label, index) => (
        <li key={label} className="flex min-w-0 items-center gap-1">
          <span
            className={`rounded-full px-2 py-0.5 text-ui-caption ${
              index === current
                ? "bg-accent font-medium text-accent-foreground"
                : index < current
                  ? "text-foreground"
                  : "text-foreground-subtlest"
            }`}
            aria-current={index === current ? "step" : undefined}
          >
            {index + 1}. {label}
          </span>
          {index < labels.length - 1 ? (
            <span className="text-foreground-subtlest" aria-hidden="true">
              ›
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
