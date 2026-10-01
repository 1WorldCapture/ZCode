/**
 * 接入 Agent 四步向导（二期 A2，范围见 SPEC.md「二期 A2」）。
 *
 * 步骤：① 服务地址 ② 身份与凭据（新 token 或复用本机凭据）③ Home 路径 ④ 核验并确认。
 * 状态只存在于本组件生命周期内（SPEC 不变量：不持久化）；来回切换不丢已填内容。
 *
 * 第 4 步先调 verifyCredential 只核验不保存，展示服务端返回的身份供用户确认，
 * 确认后才 createBinding。向导挂载即预检测宿主环境（R6，SPEC 9f51d48）：CLI
 * 缺失/版本过旧切安装命令提示页（已填内容保留，可「上一步」回向导、「重新检测」
 * 重跑探测，就绪回第 1 步）；探测失败＝未知不阻断，任一提交点的 CliMissing
 * 兜底保留。向导不执行任何安装动作。
 *
 * token 只存在于本组件的本次提交内：直传模式随提交结束即清，复用模式 UI 全程不接触。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet.js";
import {
  RemoteConnectionWizardSidebar,
  type WizardSidebarStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import { submitConnect } from "@/agents/agentCenterActions.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";
import type { RaftAgentSetupErrorCode } from "@/agents/types.js";
import {
  buildConnectInput,
  buildOccupiedBindingNames,
  cliMissingDescriptionId,
  draftErrorId,
  resolveEffectiveHomePath,
  setupErrorMessageId,
  wizardEnvPageFromCli,
  WIZARD_STEP_COUNT,
  type WizardEnvPage,
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
  // 占用者名字（bindingId → displayName，R7）：复用列表的置灰条目显示"被谁占用"。
  // list() 失败不阻塞凭据列表——名字缺失时条目回退到通用"已被占用"文案。
  const [occupiedNames, setOccupiedNames] = useState<Map<string, string>>(new Map());
  const [fieldError, setFieldError] = useState<string | null>(null);
  // 环境提示页（R6/SPEC 9f51d48）：向导挂载即预检测宿主环境，CLI 缺失或版本过旧
  // 时接管渲染（已填内容保留）。null = 就绪或未知——未知（探测 reject）不阻断
  // 向导，留给第 4 步核验的 CliMissing 兜底（现有路径）。
  const [envPage, setEnvPage] = useState<WizardEnvPage | null>(null);
  const [envChecking, setEnvChecking] = useState(false);
  // 第 4 步：核验状态与结果。
  const [verifying, setVerifying] = useState(false);
  const [identity, setIdentity] = useState<VerifyIdentity | null>(null);
  const [verifyError, setVerifyError] = useState<RaftAgentSetupErrorCode | null>(null);
  // 核验成功返回的实际生效 Home 路径（输入了回显输入，留空是服务端预派发默认）。
  const [verifiedHomePath, setVerifiedHomePath] = useState<string | null>(null);

  // 宿主环境预检测（R6）：挂载跑一次（严格模式双跑由 ref 挡住），「重新检测」
  // 复用同一函数。检测只读；期间第 1 步正常可填（不阻塞输入）。探测 reject =
  // 未知：不动 envPage——挂载时保持 null（向导可用），重测时留在提示页可再点。
  const envCheckStarted = useRef(false);
  const runEnvironmentCheck = useCallback(async () => {
    if (!service) return;
    setEnvChecking(true);
    try {
      const health = await service.getEnvironmentHealth();
      setEnvPage(wizardEnvPageFromCli(health.cli));
      if (health.cli.status === "ok") {
        // SPEC 9f51d48：重测就绪回向导第 1 步（挂载时本就是 0，无操作）。
        setStep(0);
      }
    } catch (error) {
      logger.warn("[AgentCenter] 宿主环境预检测失败（留待第 4 步核验兜底）", { error });
    } finally {
      setEnvChecking(false);
    }
  }, [service]);

  useEffect(() => {
    if (!service || envCheckStarted.current) return;
    envCheckStarted.current = true;
    void runEnvironmentCheck();
  }, [service, runEnvironmentCheck]);

  // 进入第 2 步时拉取本机凭据列表（复用选择器数据源，A1 接口）；并行拉 list()
  // 投影算占用者名字（R7）——同一份绑定记录，UI 侧 join，服务层零改动。
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
    service
      .list()
      .then((items) => {
        if (!cancelled) setOccupiedNames(buildOccupiedBindingNames(items));
      })
      .catch((error) => {
        // 名字只是增强展示：失败留在空 Map，置灰条目回退通用文案。
        logger.warn("[AgentCenter] 占用者名字加载失败", { error });
      });
    return () => {
      cancelled = true;
    };
  }, [step, service, credentials, credentialsFailed]);

  if (!service) {
    return null;
  }

  const reuseMode = reuseSlug !== null;

  // 第 4 步展示的身份与 Home：两种凭据模式都先走 verifyCredential（复用模式由服务侧
  // 读凭据、读完即弃，界面拿不到也不需要 token），统一显示核验出的身份与实际生效路径。
  const displayIdentity: VerifyIdentity | null = identity;
  const effectiveHomePath = resolveEffectiveHomePath(homeWorkspacePath, verifiedHomePath);

  const goBack = () => {
    setFieldError(null);
    setVerifyError(null);
    // 退回前面的步骤意味着 Home 输入可能再变，已核验的路径作废，重新核验。
    setVerifiedHomePath(null);
    setStep((current) => Math.max(0, current - 1) as WizardStep);
  };

  // 环境提示页的「上一步」：先摘掉提示页再回退（原实现只动 step、提示页还挂着，
  // 点了没有可见效果——R6 顺手修复）。
  const goBackFromEnvPage = () => {
    setEnvPage(null);
    goBack();
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
      // 进入确认页：先 verifyCredential 只核验不保存（直传 token，或复用凭据由
      // 服务侧读出——确认页统一显示核验出的身份与实际生效 Home 路径）。
      setStep(3);
      void runVerify();
      return;
    }
    setStep((current) => (current + 1) as WizardStep);
  };

  const runVerify = async () => {
    setVerifying(true);
    setVerifyError(null);
    setIdentity(null);
    setVerifiedHomePath(null);
    try {
      // 凭据来源二选一（与服务端 schema 的 refine 同规则）：直传 token，或复用
      // 已有凭据的 slug（服务侧读出、读完即弃）。
      const result = await service.verifyCredential({
        raftOrigin: raftOrigin.trim(),
        raftAgentId: raftAgentId.trim(),
        ...(reuseMode && reuseSlug ? { existingProfileSlug: reuseSlug } : { token }),
        // 带 Home 输入一起核验：留空时服务端返回预派发默认路径（确认页据此显示）。
        homeWorkspacePath: homeWorkspacePath.trim() || undefined,
      });
      if (!result.ok) {
        if (result.code === "CliMissing") {
          setEnvPage("CliMissing");
          return;
        }
        setVerifyError(result.code);
        return;
      }
      setIdentity(result.identity);
      setVerifiedHomePath(result.homePath);
    } catch (error) {
      logger.warn("[AgentCenter] 身份核验失败", { error });
      setVerifyError("CredentialCheckFailed");
    } finally {
      setVerifying(false);
    }
  };

  const handleConfirm = () => {
    // 确认页显示的实际 Home 路径显式回传（与核验共用服务端派生，两侧不漂移）。
    // 复用模式不下发 token，服务侧从既有 profile 读取（读取即弃，SPEC「二期 A2」）。
    const input = buildConnectInput({
      raftOrigin,
      raftAgentId,
      token,
      homeWorkspacePath,
      reuseSlug,
      effectiveHomePath,
    });
    // 无论成功失败都立即清掉输入框里的 token，重试需要重新粘贴。
    setToken("");
    void submitConnect(service, input).then((ok) => {
      if (!ok && useAgentCenterStore.getState().submitError?.code === "CliMissing") {
        setEnvPage("CliMissing");
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
    setVerifiedHomePath(null);
  };

  const switchToNewCredential = () => {
    setReuseSlug(null);
    setIdentity(null);
    setVerifyError(null);
    setVerifiedHomePath(null);
  };

  const errorText =
    fieldError ??
    (verifyError
      ? intl.formatMessage({ id: setupErrorMessageId(verifyError) })
      : null) ??
    (submitError
      ? intl.formatMessage(
          { id: setupErrorMessageId(submitError.code) },
          { detail: submitError.detail ?? "" },
        )
      : null);

  // ── 环境提示页（R6）：CLI 缺失/版本过旧接管渲染；只读检测，不执行安装 ──
  if (envPage) {
    return (
      <div className="flex h-full flex-col">
        <WizardHeader />
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-lg flex-col gap-4 py-8">
            <h2 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "agentCenter.wizard.cliMissing.title" })}
            </h2>
            <p className="text-ui-sm text-foreground-subtle" data-testid="wizard-env-page">
              {intl.formatMessage({ id: cliMissingDescriptionId(envPage) })}
            </p>
            <Snippet code={CLI_INSTALL_COMMAND}>
              <SnippetInput aria-label={intl.formatMessage({ id: "agentCenter.wizard.cliMissing.installCommand" })} />
              <SnippetCopyButton />
            </Snippet>
            <p className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.wizard.cliMissing.versionNote" })}
            </p>
            <div className="flex items-center gap-2">
              {/* 上一步：回向导继续填（已填内容全在向导 state，SPEC 9f51d48）。 */}
              <Button type="button" variant="ghost" size="sm" onClick={goBackFromEnvPage}>
                {intl.formatMessage({ id: "common.back" })}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={envChecking}
                onClick={() => void runEnvironmentCheck()}
              >
                {intl.formatMessage({
                  id: envChecking
                    ? "agentCenter.wizard.cliMissing.detecting"
                    : "agentCenter.wizard.cliMissing.redetect",
                })}
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
        <div className="flex min-w-0 gap-4 px-6 py-6">
          <RemoteConnectionWizardSidebar
            currentStep={AGENT_WIZARD_STEPS[step].key}
            steps={AGENT_WIZARD_STEPS}
            headingId={null}
          />
          <div className="flex min-w-0 max-w-lg flex-1 flex-col gap-5">
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
              occupiedNames={occupiedNames}
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
              homeWorkspacePath={effectiveHomePath}
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
                {intl.formatMessage({ id: "common.back" })}
              </Button>
            ) : null}
            {step < WIZARD_STEP_COUNT - 1 ? (
              <Button type="button" size="sm" disabled={verifying} onClick={handleNext}>
                {intl.formatMessage({ id: "common.next" })}
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
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 向导步骤定义：与 RemoteConnectionWizardSidebar 共用（步骤条不自写，R3-14）。
 * 顺序即 WizardStep 序号（0–3）。
 */
const AGENT_WIZARD_STEPS = [
  { key: "server", titleId: "agentCenter.wizard.step1.label" },
  { key: "credential", titleId: "agentCenter.wizard.step2.label" },
  { key: "home", titleId: "agentCenter.wizard.step3.label" },
  { key: "confirm", titleId: "agentCenter.wizard.step4.label" },
] as const satisfies readonly WizardSidebarStep[];

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
