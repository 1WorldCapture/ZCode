/**
 * 详情页「记忆」只读块（二期 A2，范围见 SPEC.md「二期 A2」）。
 *
 * 数据源为 A1 的记忆只读接口：listMemoryFiles 列出记忆面文件
 * （MEMORY.md / AGENTS.md / notes/**），readMemoryFile 读单文件内容
 * （512KB 上限，超出截断并带 truncated 标志）。UI 只读：不提供任何写入口。
 */
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useRaftAgentsService } from "@/agents/useAgentCenterSync.js";
import type { IRaftAgentsService } from "@zcode/services";

/** A1 接口形状（a517415a 线程定稿）——从服务接口推导，不维护第二份定义。 */
type MemoryFile = Extract<
  Awaited<ReturnType<IRaftAgentsService["listMemoryFiles"]>>,
  { ok: true }
>["files"][number];
type MemoryFileError = "NotFound" | "OutsideMemorySurface" | "Unreadable";

export function AgentMemoryPanel({ bindingId }: { bindingId: string }) {
  const { intl } = useZCodeIntl();
  const service = useRaftAgentsService();

  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [readError, setReadError] = useState<MemoryFileError | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    service
      .listMemoryFiles(bindingId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setFiles(result.files);
        } else {
          // NotFound（Home/记忆面缺失）按空处理，与其他空态一致。
          setFiles([]);
        }
      })
      .catch((error) => {
        logger.warn("[AgentCenter] 记忆文件列表加载失败", { bindingId, error });
        if (!cancelled) setListFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [service, bindingId]);

  if (!service) {
    return null;
  }

  const handleSelect = (path: string) => {
    setSelectedPath(path);
    setContent(null);
    setTruncated(false);
    setReadError(null);
    setReading(true);
    service
      .readMemoryFile(bindingId, path)
      .then((result) => {
        if (!result.ok) {
          setReadError(result.code);
          return;
        }
        setContent(result.content);
        setTruncated(result.truncated);
      })
      .catch((error) => {
        logger.warn("[AgentCenter] 记忆文件读取失败", { bindingId, path, error });
        setReadError("Unreadable");
      })
      .finally(() => {
        setReading(false);
      });
  };

  return (
    <section className="flex flex-col gap-3 border-b border-border px-6 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "agentCenter.memory.title" })}
        </h2>
        <p className="text-ui-caption text-foreground-subtlest">
          {intl.formatMessage({ id: "agentCenter.memory.description" })}
        </p>
      </div>
      {listFailed ? (
        <p className="text-ui-caption text-destructive" role="alert">
          {intl.formatMessage({ id: "agentCenter.memory.loadFailed" })}
        </p>
      ) : files === null ? (
        <p className="text-ui-caption text-foreground-subtlest">
          {intl.formatMessage({ id: "agentCenter.loading" })}
        </p>
      ) : files.length === 0 ? (
        <p className="text-ui-caption text-foreground-subtlest">
          {intl.formatMessage({ id: "agentCenter.memory.empty" })}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {files.map((file) => (
              <li key={file.path} className="min-w-0">
                <button
                  type="button"
                  onClick={() => handleSelect(file.path)}
                  aria-pressed={selectedPath === file.path}
                  className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-ui-sm ${
                    selectedPath === file.path
                      ? "bg-accent/10 text-foreground"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-ui-caption text-foreground-subtlest">
                    {formatSize(file.size)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {reading ? (
            <p className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "agentCenter.loading" })}
            </p>
          ) : null}
          {readError ? (
            <p className="text-ui-caption text-destructive" role="alert">
              {intl.formatMessage({ id: `agentCenter.memory.error.${readError}` })}
            </p>
          ) : null}
          {content !== null ? (
            <div className="min-w-0">
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2 text-ui-caption text-foreground">
                {content}
              </pre>
              {truncated ? (
                <p className="mt-1 text-ui-caption text-foreground-subtlest">
                  {intl.formatMessage({ id: "agentCenter.memory.truncated" })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
