/**
 * 接入向导各步骤的纯展示组件（props 进、回调出；状态都在 AgentConnectWizardPage）。
 *
 * 拆分原因：向导页整体超过 oxlint max-lines（400）；步骤组件无状态，便于单测与窄窗口排版。
 */
import { KeyRound, Server } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IRaftAgentsService } from "@zcode/services";

/** A1 接口形状（a517415a 线程定稿）——从服务接口推导，不维护第二份定义。 */
export type CredentialItem =
  Awaited<ReturnType<IRaftAgentsService["listLocalCredentials"]>>[number];
export type VerifyResult = Awaited<ReturnType<IRaftAgentsService["verifyCredential"]>>;
export type VerifyIdentity = Extract<VerifyResult, { ok: true }>["identity"];

/** 第 1 步：服务地址。 */
export function StepServerForm({
  raftOrigin,
  onRaftOriginChange,
}: {
  raftOrigin: string;
  onRaftOriginChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "agentCenter.wizard.step1.description" })}
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "agentCenter.form.serverUrl" })}
        </span>
        <Input
          type="text"
          value={raftOrigin}
          onChange={(event) => onRaftOriginChange(event.target.value)}
          placeholder="https://raft.example.com"
        />
      </label>
    </div>
  );
}

/** 第 2 步：身份与凭据——新 token 直传或复用本机凭据（被占用者置灰）。 */
export function StepIdentityForm({
  raftAgentId,
  token,
  reuseSlug,
  credentials,
  credentialsFailed,
  onRaftAgentIdChange,
  onTokenChange,
  onSelectCredential,
  onSwitchToNew,
}: {
  raftAgentId: string;
  token: string;
  reuseSlug: string | null;
  credentials: CredentialItem[] | null;
  credentialsFailed: boolean;
  onRaftAgentIdChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onSelectCredential: (credential: CredentialItem) => void;
  onSwitchToNew: () => void;
}) {
  const { intl } = useZCodeIntl();
  const reuseMode = reuseSlug !== null;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "agentCenter.wizard.step2.description" })}
      </p>
      {credentials !== null && credentials.length > 0 ? (
        <div className="flex flex-col gap-1.5" role="radiogroup">
          <span className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "agentCenter.wizard.reuse.title" })}
          </span>
          {credentials.map((credential) => {
            const occupied = credential.boundBindingId !== null;
            const selected = reuseSlug === credential.profileSlug;
            return (
              <button
                key={credential.profileSlug}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={occupied}
                onClick={() => onSelectCredential(credential)}
                className={`flex min-w-0 flex-col gap-0.5 rounded-md border px-3 py-2 text-left ${
                  selected
                    ? "border-accent bg-accent/10"
                    : occupied
                      ? "cursor-not-allowed opacity-50"
                      : "border-border hover:bg-muted"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground">
                  <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {credential.agentName ?? credential.agentId}
                  </span>
                </span>
                <span className="min-w-0 truncate text-ui-caption text-foreground-subtle">
                  {credential.serverUrl}
                </span>
                {occupied ? (
                  <span className="text-ui-caption text-foreground-subtlest">
                    {intl.formatMessage({ id: "agentCenter.wizard.reuse.occupied" })}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {credentials !== null && credentials.length === 0 ? (
        <p className="text-ui-caption text-foreground-subtlest">
          {intl.formatMessage({ id: "agentCenter.wizard.reuse.empty" })}
        </p>
      ) : null}
      {credentialsFailed ? (
        <p className="text-ui-caption text-foreground-subtlest">
          {intl.formatMessage({ id: "agentCenter.wizard.reuse.loadFailed" })}
        </p>
      ) : null}
      {reuseMode ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={onSwitchToNew}
        >
          {intl.formatMessage({ id: "agentCenter.wizard.reuse.switchToNew" })}
        </Button>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "agentCenter.form.agentId" })}
            </span>
            <Input
              type="text"
              value={raftAgentId}
              onChange={(event) => onRaftAgentIdChange(event.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "agentCenter.form.token" })}
            </span>
            <Input
              type="password"
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              autoComplete="off"
            />
          </label>
        </>
      )}
    </div>
  );
}

/** 第 3 步：Home 路径。 */
export function StepHomeForm({
  homeWorkspacePath,
  onHomeWorkspacePathChange,
}: {
  homeWorkspacePath: string;
  onHomeWorkspacePathChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "agentCenter.wizard.step3.description" })}
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "agentCenter.form.homePath" })}
        </span>
        <Input
          type="text"
          value={homeWorkspacePath}
          onChange={(event) => onHomeWorkspacePathChange(event.target.value)}
          placeholder={intl.formatMessage({ id: "agentCenter.form.homePathPlaceholder" })}
        />
      </label>
      <p className="text-ui-caption text-foreground-subtlest">
        {intl.formatMessage({ id: "agentCenter.wizard.step3.hint" })}
      </p>
    </div>
  );
}

/** 第 4 步：确认摘要 + 服务端身份展示。 */
export function StepConfirm({
  raftOrigin,
  raftAgentId,
  homeWorkspacePath,
  reuseMode,
  verifying,
  identity,
}: {
  raftOrigin: string;
  raftAgentId: string;
  homeWorkspacePath: string;
  reuseMode: boolean;
  verifying: boolean;
  identity: VerifyIdentity | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "agentCenter.wizard.step4.description" })}
      </p>
      <dl className="flex flex-col gap-2 rounded-md border border-border px-4 py-3">
        <SummaryRow
          label={intl.formatMessage({ id: "agentCenter.form.serverUrl" })}
          value={raftOrigin}
        />
        <SummaryRow
          label={intl.formatMessage({ id: "agentCenter.form.agentId" })}
          value={raftAgentId}
        />
        <SummaryRow
          label={intl.formatMessage({ id: "agentCenter.form.homePath" })}
          value={
            homeWorkspacePath ||
            intl.formatMessage({ id: "agentCenter.form.homePathPlaceholder" })
          }
        />
        {reuseMode ? (
          <SummaryRow
            label={intl.formatMessage({ id: "agentCenter.wizard.reuse.credential" })}
            value={intl.formatMessage({ id: "agentCenter.wizard.reuse.credentialValue" })}
          />
        ) : null}
      </dl>
      {verifying ? (
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "agentCenter.wizard.step4.verifying" })}
        </p>
      ) : null}
      {identity ? (
        <div
          className="flex flex-col gap-1.5 rounded-md border border-border px-4 py-3"
          data-testid="wizard-identity"
        >
          <span className="flex items-center gap-1.5 text-ui-sm font-medium text-foreground">
            <Server className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "agentCenter.wizard.step4.identityTitle" })}
          </span>
          <span className="text-ui-sm text-foreground">
            {identity.agentName ?? identity.agentId}
          </span>
          <span className="min-w-0 break-all text-ui-caption text-foreground-subtle">
            {identity.agentId} · {identity.serverUrl}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-ui-caption text-foreground-subtlest">{label}</dt>
      <dd className="min-w-0 break-all text-ui-base text-foreground">{value}</dd>
    </div>
  );
}
