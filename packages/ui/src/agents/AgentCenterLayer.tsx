/**
 * Agent 中心层 —— 覆盖在 workspace 壳层（或无 workspace 时独立全屏）的页面容器。
 *
 * 渲染模式与 WorkspaceSettingsLayer 一致：absolute inset-0 z-10，底层 workspace 由
 * RootWorkspaceContent 标 inert；关闭 = 关闭 Agents tab，不触碰 Agent 值守状态。
 *
 * 桌面窗口外壳对齐 SettingsPage/WorkspaceHeader 先例（R3 第 13 项，方案 B）：
 * 页头即拖拽区；mac 让出红绿灯；Windows/Linux 在页头内联自绘窗控（覆盖层会盖住
 * workspace 自己的窗控，必须自带）。非桌面（Web）app-region 类无效果，保持原样。
 */
import { X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAgentCenterStore } from "@/agents/agentCenterStore.js";
import { AgentConnectWizardPage } from "@/agents/AgentConnectWizardPage.js";
import { AgentDetailPage } from "@/agents/AgentDetailPage.js";
import { AgentListPage } from "@/agents/AgentListPage.js";
import { useAgentCenterSync, useRaftAgentsService } from "@/agents/useAgentCenterSync.js";

export function AgentCenterLayer({
  onClose,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
}: {
  onClose: () => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const view = useAgentCenterStore((state) => state.view);
  // 数据同步随 Agent 中心层挂载/卸载；关闭层不影响 host 里的值守。
  useAgentCenterSync(useRaftAgentsService());
  // Linux 与 Windows 共用内联窗控（与 WorkspaceHeader 的 usesInlineWindowControls 同口径）。
  const usesInlineWindowControls = Boolean(
    isDesktop && (isWindowsDesktop || !isMacDesktop),
  );

  return (
    <div
      // 覆盖层根补主题正文色：根上只有 bg-background 时，记忆区正文与嵌入会话
      // 视图等未显式设色的内容会继承壳层的弱化色，深色主题下几乎不可读（验收
      // 缺陷）。text-foreground 是主题变量，dark/light 自动跟随；独立表面先例
      // 见 TreemappingPane 根容器。
      className="absolute inset-0 z-10 flex flex-col bg-background text-foreground"
      data-testid="agent-center-layer"
    >
      <header
        className={cn(
          "flex h-12 shrink-0 items-center justify-between border-b border-border pl-4 pr-2 [app-region:drag]",
          // macOS 红绿灯浮在页头左侧，标题让出一个安全区（SettingsPage 侧栏 68px 同量级）。
          isMacDesktop && "pl-[72px]",
        )}
      >
        <span className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "agentCenter.title" })}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
          {usesInlineWindowControls ? <DesktopWindowControls /> : null}
          <ControlHintTooltip title={intl.formatMessage({ id: "common.close" })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="agent-center-close"
              aria-label={intl.formatMessage({ id: "common.close" })}
              onClick={onClose}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {view.page === "list" ? (
          <AgentListPage />
        ) : view.page === "connect" ? (
          <AgentConnectWizardPage />
        ) : (
          <AgentDetailPage bindingId={view.bindingId} />
        )}
      </div>
    </div>
  );
}
