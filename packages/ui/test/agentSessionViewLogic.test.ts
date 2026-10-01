import assert from "node:assert/strict";
import test from "node:test";
import { shouldReopenSession } from "../src/agents/agentSessionViewLogic.js";

test("cold start: projection without a session yet opens the view", () => {
  assert.equal(shouldReopenSession(null, null), true);
});

test("lazy-create backfill: projection catches up with the already-open session — no reopen", () => {
  // openAgentSession 懒建后投影才写入同一编号；编号一致不得重开（会闪加载态）。
  assert.equal(shouldReopenSession("sess_a", "sess_a"), false);
});

test("session swap: restart/reset changes the projection id — reopen", () => {
  assert.equal(shouldReopenSession("sess_b", "sess_a"), true);
});

test("projection id known at mount while nothing open yet — open", () => {
  assert.equal(shouldReopenSession("sess_a", null), true);
});

test("projection id lost after being open — reopen defensively (openAgentSession is idempotent)", () => {
  assert.equal(shouldReopenSession(null, "sess_a"), true);
});

test("retry path: error state keeps opened=null, so any projection id reopens", () => {
  assert.equal(shouldReopenSession("sess_a", null), true);
});
