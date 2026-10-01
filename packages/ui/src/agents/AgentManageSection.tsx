/**
 * 详情页「管理」区（二期 B1，范围见 SPEC.md「二期 A2」同文件的二期管理与 Dev-developer
 * 公布的 A1 接口形状 a517415a 线程）。
 *
 * 三个动作都带二次确认：
 * - 重启：停值守 → 新主会话（记忆保留）→ 恢复；进行中 turn 被放弃。
 * - 重置：同重启，但清空 Home 记忆面并按初始模板重建。
 * - 删除：删绑定 + 本地 profile + 整个 Home（含 projects/），不可恢复；
 *   Raft 侧 token 不撤销，确认文案明确提示。
 */
import { useState } from "react";
import { Eraser, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  removeAgent,
  resetAgent,
  restartAgent,
} from "@/agents/agentCenterActions.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";

type ManageAction = "restart" | "reset" | "remove";

export function AgentManageSection({ bindingId }: { bindingId: string }) {
  const { intl } = useZCodeIntl();
  const service = useRaftAgentsService();
  const [pending, setPending] = useState<ManageAction | null>(null);
  const [busy, setBusy] = useState(false);

  if (!service) {
    return null;
  }

  const close = () => {
    if (!busy) setPending(null);
  };

  const run = async (action: ManageAction) => {
    setBusy(true);
    try {
      if (action === "restart") {
        if (await restartAgent(service, bindingId)) setPending(null);
      } else if (action === "reset") {
        if (await resetAgent(service, bindingId)) setPending(null);
      } else {
        const result = await removeAgent(service, bindingId);
        if (!result.ok) return;
        setPending(null);
        // Home 处置四态如实提示（e3479b5 定稿）；failed 可能已部分删除，detail 只进日志。
        // untouched 细分（grokbot cb4426cd）：not_requested → 按用户选择保留；仅 refused → 请手动处理。
        const doneId =
          result.home.home === "deleted"
            ? "doneDeleted"
            : result.home.home === "kept_memory_cleared"
              ? "doneKept"
              : result.home.home === "failed"
                ? "doneFailed"
                : result.home.reason === "refused"
                  ? "doneUntouched"
                  : "doneUntouchedNotRequested";
        if (result.home.home === "failed" || result.home.home === "untouched") {
          logger.warn("[AgentCenter] Home 目录未按预期处置", {
            bindingId,
            home: result.home,
          });
        }
        toast(intl.formatMessage({ id: `agentCenter.manage.remove.${doneId}` }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 border-b border-border px-6 py-4">
      <h2 className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage({ id: "agentCenter.manage.title" })}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setPending("restart")}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "agentCenter.manage.restart" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setPending("reset")}
        >
          <Eraser className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "agentCenter.manage.reset" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          onClick={() => setPending("remove")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "agentCenter.manage.remove" })}
        </Button>
      </div>

      <ConfirmDialog
        action={pending}
        busy={busy}
        onCancel={close}
        onConfirm={() => pending && void run(pending)}
      />
    </section>
  );
}

function ConfirmDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: ManageAction | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid={`agent-manage-${action}-dialog`}>
        {action ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {intl.formatMessage({ id: `agentCenter.manage.${action}.confirmTitle` })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {intl.formatMessage({
                  id: `agentCenter.manage.${action}.confirmDescription`,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" size="sm" disabled={busy}>
                {intl.formatMessage({ id: "common.cancel" })}
              </AlertDialogCancel>
              <AlertDialogAction
                type="button"
                size="sm"
                variant={action === "remove" ? "destructive" : "default"}
                disabled={busy}
                onClick={(event) => {
                  // 结果（成功关窗/失败留窗）由 run() 决定，这里阻止 AlertDialog 默认自动关窗。
                  event.preventDefault();
                  onConfirm();
                }}
              >
                {intl.formatMessage({ id: `agentCenter.manage.${action}.confirm` })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}
