import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "#src/memory/memory.js";

const PROJECT_MEMORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** 超限策略：error = 抛 PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED（项目记忆预览语义）；truncate = 截断并置 truncated。 */
export interface StableFileReadLimits {
  maxBytes: number;
  onOversize: "error" | "truncate";
}

export async function readProjectMemoryFileFromStableHandle(params: {
  fileName: string;
  filePath: string;
  validatePath: () => Promise<void>;
  /** 缺省沿用项目记忆预览语义：5 MiB 上限、超限报错。 */
  limits?: StableFileReadLimits;
}): Promise<{ content: string; updatedAt: number; truncated: boolean }> {
  const maxBytes = params.limits?.maxBytes ?? PROJECT_MEMORY_PREVIEW_MAX_BYTES;
  const onOversize = params.limits?.onOversize ?? "error";
  const preOpenStat = await lstat(params.filePath, { bigint: true });
  if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${params.filePath}`);
  }

  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  // 路径检查后再 readFile(path) 会重新解析路径，可能跟随并发替换的链接读取外部文件。
  // 只读句柄不加锁、不获取所有权；Memory 原子更新可继续 rename，正文始终从已验证句柄读取。
  const handle = await open(params.filePath, constants.O_RDONLY | noFollowFlag);
  try {
    const openedStat = await handle.stat({ bigint: true });
    await params.validatePath();
    const postOpenStat = await lstat(params.filePath, { bigint: true });
    if (
      !openedStat.isFile() ||
      !postOpenStat.isFile() ||
      postOpenStat.isSymbolicLink() ||
      !isSameFileSnapshot(openedStat, preOpenStat) ||
      !isSameFileSnapshot(openedStat, postOpenStat)
    ) {
      throwFileChangedError(params.fileName);
    }

    if (onOversize === "error" && openedStat.size > BigInt(maxBytes)) {
      throwPreviewLimitError(params.fileName, maxBytes);
    }

    // truncate 模式只读到上限；error 模式多读 1 字节用于探测超限。
    const content = await readBoundedFile(handle, onOversize === "truncate" ? maxBytes : maxBytes + 1);
    const finalStat = await handle.stat({ bigint: true });
    // 原子 rename 失败时写入会退化为同 inode 的原地覆盖，仅读取文件身份无法识别内容变化。
    if (!isSameFileSnapshot(openedStat, finalStat)) {
      throwFileChangedError(params.fileName);
    }
    if (onOversize === "error") {
      if (content.length > maxBytes || finalStat.size > BigInt(maxBytes)) {
        throwPreviewLimitError(params.fileName, maxBytes);
      }
    }
    return {
      content: content.toString("utf-8"),
      updatedAt: Number(finalStat.mtimeNs) / 1_000_000,
      truncated: onOversize === "truncate" && finalStat.size > BigInt(maxBytes),
    };
  } finally {
    await handle.close();
  }
}

function isSameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function throwPreviewLimitError(fileName: string, maxBytes: number): never {
  throw Object.assign(
    new Error(`Project Memory file exceeds the ${maxBytes} byte preview limit: ${fileName}`),
    { code: PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE },
  );
}

function throwFileChangedError(fileName: string): never {
  throw Object.assign(new Error(`Project Memory file changed during preview: ${fileName}`), {
    code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  });
}
