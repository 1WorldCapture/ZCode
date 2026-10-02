// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

// 与 node-repl-host 同款修复：esbuild 的 esm 产物里 __require shim 在 ESM 作用域没有 require 可用，
// 依赖里的 CJS 会在模块求值阶段抛错。注入真实 createRequire。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

export const buildRaftAgentToolsBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    entryPoints: [resolve(packageRoot, "src", "entry.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
};

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === import.meta.filename) {
  await buildRaftAgentToolsBundle();
}
