// ============================================================
// Tool Path Policy
// ============================================================

import { isAbsolute, normalize, relative, resolve } from "node:path";
import { CoreErrorType, createCoreError } from "@zcode/contracts";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: "read" | "write" | "execute";
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  // Current release intentionally does not hard-block paths outside workspaceRoot.
  // Cause: subagents may need to inspect user-requested sibling repos or external files
  // before the filesystem permission adapter grows explicit ask/deny rules for them.
  return resolvedPath;
}

/**
 * Containment check for the unattended file-tool scope (`resolveWorkspacePath`
 * deliberately does not block outside-root paths — see its comment). Both inputs
 * must already be resolved absolute paths; callers resolve via resolveWorkspacePath
 * so `..` traversal and cwd-relative inputs are normalized before we compare.
 * The root itself counts as outside: file tools target files, not the root dir.
 */
export function isResolvedPathInsideRoot(resolvedPath: string, rootDir: string): boolean {
  const root = normalizeAbsoluteDirectory(rootDir, "rootDir");
  const relativePath = relative(root, normalize(resolvedPath));
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.startsWith("..\\") &&
    !isAbsolute(relativePath)
  );
}

export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
