/**
 * Agent 中心层 —— 覆盖在 workspace 壳层（或无 workspace 时独立全屏）的页面容器。
 *
 * 渲染模式与 WorkspaceSettingsLayer 一致：absolute inset-0 z-10，底层 workspace 由
 * RootWorkspaceContent 标 inert；关闭 = 关闭 Agents tab，不触碰 Agent 值守状态。
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import { AgentConnectFormPage } from "@/agents/AgentConnectFormPage.js";
import { AgentDetailPage } from "@/agents/AgentDetailPage.js";
import { AgentListPage } from "@/agents/AgentListPage.js";

export function AgentCenterLayer({ onClose }: { onClose: () => void }) {
  const { intl } = useZCodeIntl();
  const view = useAgentCenterStore((state) => state.view);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background" data-testid="agent-center-layer">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border pl-4 pr-2">
        <span className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "agentCenter.title" })}
        </span>
        <ControlHintTooltip title={intl.formatMessage({ id: "agentCenter.close" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="agent-center-close"
            aria-label={intl.formatMessage({ id: "agentCenter.close" })}
            onClick={onClose}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </ControlHintTooltip>
      </div>
      <div className="min-h-0 flex-1">
        {view.page === "list" ? (
          <AgentListPage />
        ) : view.page === "connect" ? (
          <AgentConnectFormPage />
        ) : (
          <AgentDetailPage bindingId={view.bindingId} />
        )}
      </div>
    </div>
  );
}
