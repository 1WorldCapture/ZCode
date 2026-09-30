/**
 * Agent 详情页 —— 身份与状态 + Home 入口 + 主会话视图占位。
 *
 * 会话区域在 mock 阶段为占位：task #3/T3 的主会话落地后，这里改为复用 V4 会话视图
 * （spec §10：Home 会话只从 Agent 列表进入，不注册普通 workspace tab）。
 * 关闭本页不等于停止 Agent（UI 生命周期与 Host 生命周期分离）。
 */
import { useEffect } from "react";
import { ArrowLeft, FolderOpen, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import {
  connectionStateTextClass,
  formatConnectionState,
  formatRunState,
  runStateTextClass,
} from "@/agents/agentStatusPresentation.js";

export function AgentDetailPage({ bindingId }: { bindingId: string }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const item = useAgentCenterStore((state) =>
    state.items.find((current) => current.bindingId === bindingId),
  );
  const backToList = useAgentCenterStore((state) => state.backToList);
  const startAgent = useAgentCenterStore((state) => state.startAgent);
  const pauseAgent = useAgentCenterStore((state) => state.pauseAgent);

  // 绑定被移除后（例如解绑）详情页不再有效，回到列表。
  useEffect(() => {
    if (!item) {
      backToList();
    }
  }, [item, backToList]);

  if (!item) {
    return null;
  }

  const paused = item.runState === "ReadyStopped";
  const canPause = item.runState === "Running" || item.runState === "Starting";

  const handleOpenHome = () => {
    void platform
      .openInFileManager(item.homePath)
      .then((result) => {
        if (!result.success) {
          logger.warn("[AgentCenter] 打开 Home 文件夹失败", {
            bindingId: item.bindingId,
            error: result.error,
          });
        }
      })
      .catch((error) => {
        logger.warn("[AgentCenter] 打开 Home 文件夹异常", {
          bindingId: item.bindingId,
          error,
        });
      });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
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
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {item.displayName}
        </span>
        {canPause ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => pauseAgent(item.bindingId)}
          >
            <Square className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "agentCenter.pause" })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={!paused}
            onClick={() => startAgent(item.bindingId)}
          >
            <Play className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "agentCenter.start" })}
          </Button>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <dl className="flex flex-col gap-3 border-b border-border px-6 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.detail.raftServer" })}
            </dt>
            <dd className="min-w-0 truncate text-ui-base text-foreground">{item.raftOrigin}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.detail.connectionState" })}
            </dt>
            <dd className={connectionStateTextClass(item.connectionState)}>
              {formatConnectionState(intl.formatMessage, item.connectionState)}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.detail.runState" })}
            </dt>
            <dd className={runStateTextClass(item.runState)}>
              {formatRunState(intl.formatMessage, item.runState)}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.homePath" })}
            </dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground" title={item.homePath}>
                {item.homePath}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={handleOpenHome}
              >
                <FolderOpen className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "agentCenter.openHome" })}
              </Button>
            </dd>
          </div>
        </dl>
        <div className="flex h-64 items-center justify-center px-6">
          <p className="max-w-80 text-center text-ui-caption text-foreground-subtlest">
            {intl.formatMessage({ id: "agentCenter.detail.sessionPlaceholder" })}
          </p>
        </div>
      </div>
    </div>
  );
}
