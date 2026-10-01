/**
 * 构建期开关（Raft 构建 / TinyCode 身份）与产品形态解析的测试。
 * 跑法：node --test scripts/desktop-product-identity.test.mjs（desktop 无集中 test script）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ZCODE_RAFT_BUILD_ENV,
  ZCODE_TINYCODE_IDENTITY_ENV,
  ZCODE_PREVIEW_IDENTITY_ENV,
  desktopProductIdentities,
  isRaftBuildRequested,
  isTinycodeIdentityRequested,
  resolveDesktopProductFlavor,
  resolveWindowsAppUserModelIdForFlavor,
} from "./desktop-product-identity.mjs";

test("isRaftBuildRequested：只认 1 开启，0/空/缺省关闭", () => {
  assert.equal(isRaftBuildRequested({ [ZCODE_RAFT_BUILD_ENV]: "1" }), true);
  assert.equal(isRaftBuildRequested({ [ZCODE_RAFT_BUILD_ENV]: "0" }), false);
  assert.equal(isRaftBuildRequested({ [ZCODE_RAFT_BUILD_ENV]: "" }), false);
  assert.equal(isRaftBuildRequested({}), false, "官方 CI 不带此变量必须恒为关闭");
  assert.equal(isRaftBuildRequested({ [ZCODE_RAFT_BUILD_ENV]: " 1 " }), true, "允许空白");
});

test("isRaftBuildRequested：其它拼写构建期直接失败（防 true 之类漏网成开启）", () => {
  for (const bad of ["true", "yes", "on", "TRUE", "2"]) {
    assert.throws(
      () => isRaftBuildRequested({ [ZCODE_RAFT_BUILD_ENV]: bad }),
      new RegExp(`invalid ${ZCODE_RAFT_BUILD_ENV}=${bad}`),
    );
  }
});

test("isTinycodeIdentityRequested：只认 1 开启，0/空/缺省关闭", () => {
  assert.equal(isTinycodeIdentityRequested({ [ZCODE_TINYCODE_IDENTITY_ENV]: "1" }), true);
  assert.equal(isTinycodeIdentityRequested({ [ZCODE_TINYCODE_IDENTITY_ENV]: "0" }), false);
  assert.equal(isTinycodeIdentityRequested({ [ZCODE_TINYCODE_IDENTITY_ENV]: "" }), false);
  assert.equal(isTinycodeIdentityRequested({}), false);
  assert.equal(isTinycodeIdentityRequested({ [ZCODE_TINYCODE_IDENTITY_ENV]: " 1 " }), true, "允许空白");
});

test("isTinycodeIdentityRequested：其它拼写构建期直接失败", () => {
  for (const bad of ["true", "yes", "on", "TINY", "2"]) {
    assert.throws(
      () => isTinycodeIdentityRequested({ [ZCODE_TINYCODE_IDENTITY_ENV]: bad }),
      new RegExp(`invalid ${ZCODE_TINYCODE_IDENTITY_ENV}=${bad}`),
    );
  }
});

test("resolveDesktopProductFlavor：TinyCode 身份优先于 ZCODE_ENV 推导", () => {
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_ENV: "production", [ZCODE_TINYCODE_IDENTITY_ENV]: "1" }),
    "tinycode",
  );
  // ZCODE_ENV=test 的缺省身份是 preview，但显式 TinyCode 开关优先（身份与环境是两个轴）。
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_ENV: "test", [ZCODE_TINYCODE_IDENTITY_ENV]: "1" }),
    "tinycode",
  );
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "production" }), "production");
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "test" }), "preview");
});

test("resolveDesktopProductFlavor：Preview 与 TinyCode 同时开启构建期报错（互斥）", () => {
  assert.throws(
    () =>
      resolveDesktopProductFlavor({
        ZCODE_ENV: "production",
        [ZCODE_PREVIEW_IDENTITY_ENV]: "1",
        [ZCODE_TINYCODE_IDENTITY_ENV]: "1",
      }),
    /mutually exclusive/,
  );
});

test("TinyCode 身份表：appId/名称与 AUMID 表查找一致", () => {
  const identity = desktopProductIdentities.tinycode;
  assert.equal(identity.appId, "build.raft.tinycode");
  assert.equal(identity.productName, "TinyCode");
  assert.equal(resolveWindowsAppUserModelIdForFlavor("tinycode"), identity.appId);
  assert.equal(resolveWindowsAppUserModelIdForFlavor("preview"), desktopProductIdentities.preview.appId);
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("production"),
    desktopProductIdentities.production.appId,
  );
  // 未知 flavor 回落 production，保持旧版二态映射的 fail-safe 行为。
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor(undefined),
    desktopProductIdentities.production.appId,
  );
});

test("身份表与 shared 运行时显示名一致（构建期/运行时单一来源对账）", () => {
  const sharedSource = readFileSync(new URL("../../../packages/shared/src/env.ts", import.meta.url), "utf8");
  for (const identity of Object.values(desktopProductIdentities)) {
    const expected = `${identity.flavor}: "${identity.productName}",`;
    assert.ok(
      sharedSource.includes(expected),
      `shared/src/env.ts 的 ZCODE_PRODUCT_DISPLAY_NAMES 缺少 ${expected}`,
    );
  }
});
