/**
 * 接入 Agent 单表单页（第一期入口形态，范围文档已拍板）。
 *
 * 字段：服务地址、Agent ID、token（密码框）、Home 路径。
 * mock 阶段仅做客户端校验并写入内存 store；task #2 接入官方 raft CLI 后，
 * 提交改为「stdin 传 token → raft agent login → 核验身份一致 → 落盘绑定」，见 spec §4。
 */
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import { submitConnect } from "@/agents/agentCenterActions.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";
import type { RaftAgentSetupErrorCode } from "@/agents/types.js";

/** 每个接入错误码对应一条用户可理解的表单文案（穷尽：新增错误码会在这里编译报错）。 */
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
    case "HomeOverlapsCredentials":
    case "AlreadyBound":
    case "ProvisioningFailed":
    case "StoreWriteFailed":
      return `agentCenter.form.error.${code}`;
  }
}

export function AgentConnectFormPage() {
  const { intl } = useZCodeIntl();
  const backToList = useAgentCenterStore((state) => state.backToList);
  const service = useRaftAgentsService();
  const submitting = useAgentCenterStore((state) => state.submitting);
  const submitError = useAgentCenterStore((state) => state.submitError);

  const [raftOrigin, setRaftOrigin] = useState("");
  const [raftAgentId, setRaftAgentId] = useState("");
  const [token, setToken] = useState("");
  const [homeWorkspacePath, setHomeWorkspacePath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!service) return;
    // 只做必填校验；地址/Agent ID/Home 路径的格式与唯一性由服务端统一判定并返回错误码。
    if (!raftOrigin.trim() || !raftAgentId.trim() || !token.trim()) {
      setError(intl.formatMessage({ id: "agentCenter.form.error.required" }));
      return;
    }
    setError(null);
    // Token 只存在于本次提交：经服务直达官方 CLI 的 stdin，不进日志、argv、持久 store 与 Home。
    const input = {
      raftOrigin: raftOrigin.trim(),
      raftAgentId: raftAgentId.trim(),
      token,
      ...(homeWorkspacePath.trim() ? { homeWorkspacePath: homeWorkspacePath.trim() } : {}),
    };
    // 无论成功失败都立即清掉输入框里的 token，重试需要重新粘贴。
    setToken("");
    void submitConnect(service, input);
  };

  const errorText =
    error ??
    (submitError
      ? intl.formatMessage(
          { id: setupErrorMessageId(submitError.code) },
          { detail: submitError.detail ?? "" },
        )
      : null);

  return (
    <div className="flex h-full flex-col">
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
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex max-w-lg flex-col gap-4 px-6 py-6">
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "agentCenter.form.description" })}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "agentCenter.form.serverUrl" })}
            </span>
            <Input
              type="text"
              value={raftOrigin}
              onChange={(event) => setRaftOrigin(event.target.value)}
              placeholder="https://raft.example.com"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "agentCenter.form.agentId" })}
            </span>
            <Input
              type="text"
              value={raftAgentId}
              onChange={(event) => setRaftAgentId(event.target.value)}
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
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "agentCenter.form.homePath" })}
            </span>
            <Input
              type="text"
              value={homeWorkspacePath}
              onChange={(event) => setHomeWorkspacePath(event.target.value)}
              placeholder={intl.formatMessage({ id: "agentCenter.form.homePathPlaceholder" })}
            />
          </label>
          {errorText ? (
            <p className="text-ui-caption text-destructive" role="alert">
              {errorText}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={submitting || !service}
              onClick={handleSubmit}
            >
              {intl.formatMessage({
                id: submitting ? "agentCenter.form.saving" : "agentCenter.form.save",
              })}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={backToList}>
              {intl.formatMessage({ id: "agentCenter.form.cancel" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
