/**
 * Agent 详情页嵌入的主会话视图（二期 B3，范围见 SPEC.md「二期 B3」）。
 *
 * 打开时机：挂载即调 openAgentSession（先恢复后订阅——拿到坐标才挂会话视图；
 * 懒建未发生 mainSessionId=null 的冷态也走它冷恢复，UI 不自行 resume）。
 *
 * 订阅隔离（grokbot 约束）：数据面走 V4PaneConversationProvider —— 它从
 * workspaceConnectionRegistry 按 (endpoint, workspaceKey) 租连接，与工作区
 * workbench 的 pane 共用同一注册表桶；同一会话被工作区与本视图同时打开时，
 * SessionDataLayer 的 refCount 把两条路径收口为一条订阅、一份投影 store
 * （多视图单订阅）。不可用 V4ConversationProvider / V4ChatPane：它们自建
 * transport，与 workbench 共享同一 zcodeAgentService（同一 connectionId），
 * 同 topic 二次 subscribe 会顶掉工作区的路由（zcodeAgentService 的注册表
 * 按 ownership key 替换），造成两边订阅拉锯。
 *
 * 覆盖层限制：focused=false（全局快捷键不灌进 Agent 中心）、telemetryVisible=false
 * （覆盖层在 workspace telemetry attachment 之外）；onOpen* 系列回调依赖 app-shell
 * 容器（code viewer / 副屏 tab），覆盖层没有这些宿主能力，一期不下发——点子代理、
 * 文件链接等在嵌入视图内无跳转。
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";
import type { RaftAgentOpenSessionErrorCode } from "@/agents/types.js";

/** 详情页专属 paneId（paneLayoutTree 保留 id 之外；详情页同时只挂一个会话视图）。 */
const AGENT_HOME_PANE_ID = "agent-home-session";

interface OpenedSession {
  sessionId: string;
  workspacePath: string;
}

export function AgentHomeSessionView({ bindingId }: { bindingId: string }) {
  const { intl } = useZCodeIntl();
  const service = useRaftAgentsService();
  const [opened, setOpened] = useState<OpenedSession | null>(null);
  const [errorCode, setErrorCode] = useState<RaftAgentOpenSessionErrorCode | null>(null);
  const [attempt, setAttempt] = useState(0);

  // scope 引用必须稳定（是 Provider 内部建连 memo 的依赖），在早退分支之前算好；
  // 未打开时占位空串，不会渲染到 Provider。
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({ workspacePath: opened?.workspacePath ?? "" }),
    [opened],
  );

  useEffect(() => {
    if (!service) return undefined;
    let cancelled = false;
    setOpened(null);
    setErrorCode(null);
    service
      .openAgentSession(bindingId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setOpened({ sessionId: result.sessionId, workspacePath: result.workspacePath });
        } else {
          setErrorCode(result.code);
        }
      })
      .catch((error) => {
        logger.warn("[AgentCenter] 主会话打开失败", { error });
        if (!cancelled) setErrorCode("SessionResumeFailed");
      });
    return () => {
      cancelled = true;
    };
  }, [service, bindingId, attempt]);

  if (errorCode) {
    return (
      <div className="flex flex-col gap-2 px-6 py-4">
        <Alert variant="destructive">
          <AlertTitle>
            {intl.formatMessage({ id: `agentCenter.session.error.${errorCode}` })}
          </AlertTitle>
        </Alert>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      </div>
    );
  }

  if (!opened) {
    return (
      <div className="flex h-64 items-center justify-center px-6">
        <p className="flex items-center gap-2 text-ui-caption text-foreground-subtle" role="status">
          <Spinner className="size-3.5" />
          {intl.formatMessage({ id: "agentCenter.session.opening" })}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-6 mb-4 flex h-[480px] min-w-0 flex-col overflow-hidden rounded-lg border border-border">
      <V4PaneConversationProvider scope={scope}>
        <SessionPane
          paneId={AGENT_HOME_PANE_ID}
          sessionId={opened.sessionId}
          openTrigger="pane"
          workspacePath={opened.workspacePath}
          focused={false}
          telemetryVisible={false}
        />
      </V4PaneConversationProvider>
    </div>
  );
}
