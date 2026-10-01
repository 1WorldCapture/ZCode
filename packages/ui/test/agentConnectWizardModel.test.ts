import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConnectInput,
  draftErrorId,
  resolveEffectiveHomePath,
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

test("确认页 Home 路径：核验返回值优先，否则退回用户输入（去空白）", () => {
  // 核验成功：无论用户是否输入，都显示服务端返回的实际生效路径。
  assert.equal(resolveEffectiveHomePath("", "/home/agent/default"), "/home/agent/default");
  assert.equal(resolveEffectiveHomePath("/custom", "/custom"), "/custom");
  // 核验前/失败：退回用户输入（trim，可能为空 → 确认页显示占位）。
  assert.equal(resolveEffectiveHomePath(" /custom ", null), "/custom");
  assert.equal(resolveEffectiveHomePath("  ", null), "");
});

test("输入构造：确认页生效路径显式回传，缺省时退回草稿字段", () => {
  const withVerified = buildConnectInput(
    draft({ homeWorkspacePath: "" }) as WizardDraft & { effectiveHomePath?: string },
  );
  assert.ok(!("homeWorkspacePath" in withVerified));

  const effective = buildConnectInput({
    ...draft(),
    effectiveHomePath: "/home/agent/default",
  });
  assert.equal(effective.homeWorkspacePath, "/home/agent/default");
});

test("错误码翻译：全部 setup 错误码都映射到 i18n 文案，不允许原始错误码上屏", async () => {
  const { setupErrorMessageId } = await import("../src/agents/agentConnectWizardModel.js");
  const { raftAgentSetupErrorCodeSchema } = await import("@zcode/shared");
  for (const code of raftAgentSetupErrorCodeSchema.options) {
    const id = setupErrorMessageId(code);
    assert.equal(id, `agentCenter.form.error.${code}`);
    assert.ok(!id.includes("TokenInvalid") || code === "TokenInvalid");
  }
});
