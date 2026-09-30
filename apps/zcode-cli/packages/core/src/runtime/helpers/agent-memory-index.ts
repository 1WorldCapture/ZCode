import { join } from "node:path";

import { AgentMemoryUnavailableError } from "../../memory/agent-memory.js";
import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import {
  createReadFileStateKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Raft Agent 记忆索引的严格加载：Home 或 MEMORY.md 缺失/不可读/为空一律抛
 * AgentMemoryUnavailableError，不走项目记忆的宽松 catch（那会让 Agent 以「全新」状态继续）。
 */
export async function loadAgentMemoryIndexContent(
  runtime: AgentRuntimeInternal,
  memoryRoot: string,
): Promise<string> {
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort) throw new AgentMemoryUnavailableError("home_missing", "no_file_system_port");
  // stat 对不存在的路径返回 kind:"missing" 而不是抛错，必须按 kind 判定。
  let homeKind: string;
  try {
    homeKind = (await fileSystemPort.stat({ path: memoryRoot })).kind;
  } catch {
    homeKind = "missing";
  }
  if (homeKind !== "directory") throw new AgentMemoryUnavailableError("home_missing");
  const indexPath = join(memoryRoot, "MEMORY.md");
  let indexKind: string;
  try {
    indexKind = (await fileSystemPort.stat({ path: indexPath })).kind;
  } catch {
    indexKind = "missing";
  }
  if (indexKind === "missing") throw new AgentMemoryUnavailableError("memory_missing");
  // 只接受普通文件：符号链接/目录/其他会把任意内容读进模型上下文或读不出来。
  if (indexKind !== "file") {
    throw new AgentMemoryUnavailableError("memory_unreadable", `kind=${indexKind}`);
  }
  let read: Awaited<ReturnType<typeof fileSystemPort.readTextFile>>;
  try {
    read = await fileSystemPort.readTextFile({ path: indexPath });
  } catch (error) {
    throw new AgentMemoryUnavailableError(
      "memory_unreadable",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (read.content.trim().length === 0) throw new AgentMemoryUnavailableError("memory_empty");
  const formattedContent = formatProjectMemoryIndexContent(read.content);
  runtime.readFileState.set(createReadFileStateKey(indexPath, undefined, undefined), {
    content: read.content,
    isPartialView: formattedContent !== read.content,
    limit: undefined,
    mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
    offset: undefined,
    path: indexPath,
    readAt: runtime.now(),
    revisionId: read.revision?.id,
    sizeBytes: read.sizeBytes,
  });
  return read.content;
}
