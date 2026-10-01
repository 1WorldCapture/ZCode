/**
 * Raft 绑定归属标记的持久化行为（R4 修复，评审发现）：
 * 1. 运行态快照重同步（一轮结束后的 syncer / getTaskSnapshot / 无参 resumeTask）
 *    不冲掉 raftBindingId——syncTaskMeta 按已存值兜底；
 * 2. raft_binding_id 索引投影列 + listSessionsByRaftBinding：按绑定过滤、
 *    排除已删除、创建时间倒序。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ZCodeTaskMeta } from "@zcode/shared";

import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

const HOME_WS = "/tmp/raft-homes/binding-1/workspace";

function raftMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "raft-sess-1",
    traceId: "zcode-raft-sess-1",
    title: "Raft 值守会话",
    workspacePath: HOME_WS,
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("syncTaskMeta：运行态快照不带 raftBindingId 时保留已存归属", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-binding-projection-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  await repo.syncTaskMeta({ meta: raftMeta({ raftBindingId: "binding-1", updatedAt: 10 }) });
  // 模拟一轮对话后的状态重同步：protocol snapshot 的 meta 不带绑定标记
  //（此前会把归属冲掉，B2/B3 随即按绑定失联——grokbot 评审发现的缺陷）。
  await repo.syncTaskMeta({ meta: raftMeta({ status: "running", updatedAt: 20 }) });
  const after = await repo.getTaskMeta({
    workspacePath: HOME_WS,
    taskId: "raft-sess-1",
  });
  assert.equal(after?.raftBindingId, "binding-1");
});

test("listSessionsByRaftBinding：按绑定过滤、排除已删除、创建时间倒序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-binding-list-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  await repo.syncTaskMeta({
    meta: raftMeta({ taskId: "s-old", traceId: "zcode-s-old", raftBindingId: "binding-1", createdAt: 1, updatedAt: 1 }),
  });
  await repo.syncTaskMeta({
    meta: raftMeta({ taskId: "s-new", traceId: "zcode-s-new", raftBindingId: "binding-1", createdAt: 2, updatedAt: 2 }),
  });
  await repo.syncTaskMeta({
    meta: raftMeta({ taskId: "s-dead", traceId: "zcode-s-dead", raftBindingId: "binding-1", createdAt: 3, updatedAt: 3 }),
  });
  await repo.syncTaskMeta({
    meta: raftMeta({ taskId: "s-other", traceId: "zcode-s-other", raftBindingId: "binding-2", createdAt: 4, updatedAt: 4 }),
  });
  await repo.updateTaskState({
    workspacePath: HOME_WS,
    taskId: "s-dead",
    patch: { deleted: true },
  });

  const ofBinding1 = await repo.listSessionsByRaftBinding("binding-1");
  assert.deepEqual(
    ofBinding1.map((meta) => meta.taskId),
    ["s-new", "s-old"],
    "只含该绑定未删除的会话，创建时间倒序",
  );
  assert.ok(ofBinding1.every((meta) => meta.raftBindingId === "binding-1"));

  const ofBinding2 = await repo.listSessionsByRaftBinding("binding-2");
  assert.deepEqual(ofBinding2.map((meta) => meta.taskId), ["s-other"]);

  const none = await repo.listSessionsByRaftBinding("binding-none");
  assert.deepEqual(none, []);
});
