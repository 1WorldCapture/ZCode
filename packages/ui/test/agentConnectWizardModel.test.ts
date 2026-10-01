import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConnectInput,
  draftErrorId,
  WIZARD_STEP_COUNT,
  type WizardDraft,
} from "../src/agents/agentConnectWizardModel.js";

const draft = (overrides: Partial<WizardDraft> = {}): WizardDraft => ({
  raftOrigin: "https://raft.example.com",
  raftAgentId: "a".repeat(8),
  token: "sk_agent_secret",
  homeWorkspacePath: "",
  reuseSlug: null,
  ...overrides,
});

test("步骤校验：第 1 步要求服务地址，第 2 步要求身份（复用模式豁免），其余恒过", () => {
  assert.equal(draftErrorId(draft({ raftOrigin: "  " }), 0), "agentCenter.wizard.error.originRequired");
  assert.equal(draftErrorId(draft({ raftOrigin: " https://raft.example.com " }), 0), null);

  assert.equal(
    draftErrorId(draft({ raftAgentId: "", token: "" }), 1),
    "agentCenter.wizard.error.identityRequired",
  );
  assert.equal(
    draftErrorId(draft({ token: "" }), 1),
    "agentCenter.wizard.error.identityRequired",
  );
  // 复用模式：身份沿原凭据，不填 Agent ID / token 也可推进。
  assert.equal(draftErrorId(draft({ raftAgentId: "", token: "", reuseSlug: "slug-1" }), 1), null);
  assert.equal(draftErrorId(draft(), 1), null);

  assert.equal(draftErrorId(draft({ homeWorkspacePath: "" }), 2), null);
  assert.equal(draftErrorId(draft(), 3), null);
});

test("输入构造：新凭据直传 token，复用凭据不下发 token", () => {
  assert.deepEqual(buildConnectInput(draft()), {
    raftOrigin: "https://raft.example.com",
    raftAgentId: "a".repeat(8),
    token: "sk_agent_secret",
  });

  const reuse = buildConnectInput(draft({ reuseSlug: "slug-1", token: "" }));
  assert.deepEqual(reuse, {
    raftOrigin: "https://raft.example.com",
    raftAgentId: "a".repeat(8),
    existingProfileSlug: "slug-1",
  });
  assert.ok(!("token" in reuse), "复用模式输入不得携带 token 字段");
});

test("输入构造：Home 路径留空不下发，填写则去除首尾空白", () => {
  assert.ok(!("homeWorkspacePath" in buildConnectInput(draft({ homeWorkspacePath: "  " }))));
  assert.equal(
    buildConnectInput(draft({ homeWorkspacePath: " /home/agent " })).homeWorkspacePath,
    "/home/agent",
  );
});

test("步骤数为 4", () => {
  assert.equal(WIZARD_STEP_COUNT, 4);
});
