/**
 * Agent 列表页 —— Agent 中心首页。
 *
 * 数据来自 Binding registry 投影（mock 阶段为内存假数据，spec §10：不允许从 tabStore 推导）。
 * 空状态显示"接入 Agent"引导；每行区分用户暂停与异常暂停（带原因）。
 */
import { Bot, Play, Plus, Square } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { StatusDot } from "@/settings/StatusDot.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import { pauseAgent, startAgent } from "@/agents/agentCenterActions.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";
import { isErrorPaused, type RaftAgentActivity } from "@/agents/types.js";
import {
  connectionStateTextClass,
  formatConnectionState,
  formatRunState,
  runStateDot,
  runStateTextClass,
} from "@/agents/agentStatusPresentation.js";

export function AgentListPage() {
  const { intl } = useZCodeIntl();
  const service = useRaftAgentsService();
  const items = useAgentCenterStore((state) => state.items);
  const loaded = useAgentCenterStore((state) => state.loaded);
  const loadFailed = useAgentCenterStore((state) => state.loadFailed);
  const corruptStorage = useAgentCenterStore((state) => state.corruptStorage);
  const actionFailed = useAgentCenterStore((state) => state.actionFailed);
  const openConnectForm = useAgentCenterStore((state) => state.openConnectForm);
  const openDetail = useAgentCenterStore((state) => state.openDetail);

  // 当前环境没有装配 Raft Agents 服务（如 Web/远端）：如实说明，不显示空列表引导。
  if (!service) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="max-w-72 text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "agentCenter.unavailable" })}
        </p>
      </div>
    );
  }

  // 首次加载完成前不显示空态，避免闪一下「还没有接入任何 Agent」。
  if (!loaded) {
    if (corruptStorage) {
      return (
        <div className="flex h-full items-center justify-center px-6">
          <div className="w-full max-w-lg">
            <CorruptStorageNotice backupPath={corruptStorage.backupPath} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="flex items-center gap-2 text-ui-caption text-foreground-subtle" role="status">
          {!loadFailed ? <Spinner className="size-3.5" /> : null}
          {intl.formatMessage({
            id: loadFailed ? "agentCenter.loadFailed" : "common.loading",
          })}
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Bot className="size-8 text-foreground-subtlest" aria-hidden="true" />
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "agentCenter.emptyTitle" })}
        </div>
        <div className="max-w-72 text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "agentCenter.emptyDescription" })}
        </div>
        <Button type="button" size="sm" className="mt-1 gap-1.5" onClick={openConnectForm}>
          <Plus className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "agentCenter.connect" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-ui-sm font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "agentCenter.agentCount" }, { count: items.length })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={openConnectForm}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "agentCenter.connect" })}
        </Button>
      </div>
      {corruptStorage ? (
        <div className="border-b border-border px-4 py-2">
          <CorruptStorageNotice backupPath={corruptStorage.backupPath} />
        </div>
      ) : loadFailed || actionFailed ? (
        <p
          className="border-b border-border px-4 py-2 text-ui-caption text-destructive"
          role="alert"
        >
          {intl.formatMessage({
            id: actionFailed ? "agentCenter.actionFailed" : "agentCenter.refreshFailed",
          })}
        </p>
      ) : null}
      <ul className="min-w-0 flex-1 overflow-y-auto p-2" data-testid="agent-center-list">
        {items.map((item) => {
          // 用户暂停与异常暂停都允许再次点「开始」（异常暂停按原因修复后重新拉起）。
          const canStart = item.runState === "ReadyStopped" || isErrorPaused(item.runState);
          const canPause = item.runState === "Running" || item.runState === "Starting";
          return (
            <li key={item.bindingId} className="group/agent-row">
              <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-hover">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  onClick={() => openDetail(item.bindingId)}
                >
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {item.displayName}
                  </span>
                  <span className="min-w-0 truncate text-ui-caption text-foreground-subtlest">
                    {item.raftOrigin}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-ui-caption">
                    <span className={connectionStateTextClass(item.connectionState)}>
                      {formatConnectionState(intl.formatMessage, item.connectionState)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <StatusDot {...runStateDot(item.runState)} />
                      <span className={runStateTextClass(item.runState)}>
                        {formatRunState(intl.formatMessage, item.runState)}
                      </span>
                    </span>
                  </span>
                  <ActivityLiveLine activity={item.activity} />
                </button>
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/agent-row:opacity-100 group-focus-within/agent-row:opacity-100 [@media(hover:none)]:opacity-100">
                  {canPause ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "agentCenter.pause" })}
                      onClick={() => void pauseAgent(service, item.bindingId)}
                    >
                      <Square className="size-3.5" aria-hidden="true" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "agentCenter.start" })}
                      disabled={!canStart}
                      onClick={() => void startAgent(service, item.bindingId)}
                    >
                      <Play className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 列表行的 B2 活动轻量行（详情页为全量）：处理中事项、待处理数、等审批
 * 醒目提示（warning 色，>0 才显示）、最近错误（错误码 + 时间）。
 * B2 字段是 optional（旧投影缺省），四项都为空时整行不渲染。
 */
function ActivityLiveLine({ activity }: { activity: RaftAgentActivity | undefined }) {
  const { intl } = useZCodeIntl();
  if (
    !activity ||
    (activity.phase !== "working" &&
      !activity.pendingCount &&
      activity.pendingApprovals === 0 &&
      !activity.lastError)
  ) {
    return null;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-ui-caption">
      {activity.phase === "working" ? (
        <span className="min-w-0 truncate text-foreground-subtle">
          {activity.currentItem ??
            intl.formatMessage({ id: "agentCenter.activity.phase.working" })}
        </span>
      ) : null}
      {activity.pendingCount ? (
        <span className="shrink-0 text-foreground-subtle">
          {intl.formatMessage(
            { id: "agentCenter.activity.pendingCount" },
            { count: activity.pendingCount },
          )}
        </span>
      ) : null}
      {activity.pendingApprovals > 0 ? (
        <span className="shrink-0 text-warning" role="status">
          {intl.formatMessage(
            { id: "agentCenter.activity.pendingApprovals.short" },
            { count: activity.pendingApprovals },
          )}
        </span>
      ) : null}
      {activity.lastError ? (
        <span className="min-w-0 truncate text-destructive">
          {activity.lastError.code ??
            intl.formatMessage({ id: "agentCenter.activity.lastError" })}
          {" · "}
          {new Date(activity.lastError.at).toLocaleString()}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 绑定记录文件损坏的定向提示（PM 定稿文案）。fail-closed：原文件保留，等用户
 * 手动恢复后探测自动回到 ok。备份路径为 null（创建备份失败）时如实改说。
 */
function CorruptStorageNotice({ backupPath }: { backupPath: string | null }) {
  const { intl } = useZCodeIntl();
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {intl.formatMessage(
          { id: backupPath ? "agentCenter.storageCorrupt.withBackup" : "agentCenter.storageCorrupt.withoutBackup" },
          backupPath ? { backupPath } : undefined,
        )}
      </AlertDescription>
    </Alert>
  );
}
