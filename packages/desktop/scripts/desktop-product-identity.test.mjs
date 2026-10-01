/**
 * Raft 构建期开关（isRaftBuildRequested）的 fail-safe 拼写规则测试。
 * 跑法：node --test scripts/desktop-product-identity.test.mjs（desktop 无集中 test script）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ZCODE_RAFT_BUILD_ENV, isRaftBuildRequested } from "./desktop-product-identity.mjs";

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
