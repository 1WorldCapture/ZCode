// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/** 复用凭据第二来源（~/.slock/profiles）：枚举、托管置灰、token 兜底拒绝、路径守卫。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRaftProfilesCatalog } from "../src/raft-agents/adapters/profilesCatalog.js";
import { resolveCredentialToken } from "../src/raft-agents/app/credentialToken.js";

const HOSTED = "11111111-1111-4111-8111-111111111111";
const FREE = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "raft-slock-"));
  const own = join(root, "zcode", "raft", "profiles");
  const slockHome = join(root, ".slock");
  const write = async (dir: string, slug: string, agentId: string, apiKey: string) => {
    await mkdir(join(dir, slug), { recursive: true });
    await writeFile(
      join(dir, slug, "credential.json"),
      JSON.stringify({ serverUrl: "https://raft.example.com", serverId: "srv-1", agentId, apiKey, createdAt: "t" }),
    );
  };
  await write(own, "own-one", FREE, "sk_agent_own");
  await write(join(slockHome, "profiles"), "hosted", HOSTED, "sk_agent_hosted");
  await write(join(slockHome, "profiles"), "free", FREE, "sk_agent_free");
  await mkdir(join(slockHome, "agents", HOSTED), { recursive: true });
  return { root, own, slockHome, catalog: createRaftProfilesCatalog(own, { slockHome }) };
}

test("list：slock 来源带前缀、标托管；apiKey 不外泄", async () => {
  const { root, catalog } = await setup();
  try {
    const entries = await catalog.list();
    const bySlug = Object.fromEntries(entries.map((e) => [e.profileSlug, e]));
    assert.deepEqual(Object.keys(bySlug).sort(), ["own-one", "slock:free", "slock:hosted"]);
    assert.equal(bySlug["own-one"]?.source, undefined);
    assert.equal(bySlug["slock:hosted"]?.hostedByRaftDaemon, true);
    assert.equal(bySlug["slock:free"]?.hostedByRaftDaemon, false);
    assert.equal(JSON.stringify(entries).includes("sk_agent_"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未配置 slockHome 时只枚举自有来源，slock: 前缀读不到", async () => {
  const { root, own } = await setup();
  try {
    const catalog = createRaftProfilesCatalog(own);
    assert.deepEqual((await catalog.list()).map((e) => e.profileSlug), ["own-one"]);
    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "slock:free" }), { ok: false, code: "Missing" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProfileToken：托管的拒读，未托管的可读，穿越拒绝", async () => {
  const { root, catalog } = await setup();
  try {
    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "slock:hosted" }), {
      ok: false,
      code: "HostedByRaftDaemon",
    });
    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "slock:free" }), {
      ok: true,
      token: "sk_agent_free",
    });
    assert.deepEqual(await catalog.resolveProfileToken({ profileSlug: "slock:../x" }), { ok: false, code: "Missing" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCredentialToken：托管凭据按 ProfileInUse(raft_daemon) 拒绝", async () => {
  const { root, catalog } = await setup();
  try {
    const store = { readAll: async () => [], writeAll: async () => {} };
    const denied = await resolveCredentialToken({ store, profilesCatalog: catalog }, { existingProfileSlug: "slock:hosted" });
    assert.deepEqual(denied, { ok: false, code: "ProfileInUse", detail: "raft_daemon" });
    const ok = await resolveCredentialToken({ store, profilesCatalog: catalog }, { existingProfileSlug: "slock:free" });
    assert.deepEqual(ok, { ok: true, token: "sk_agent_free" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
