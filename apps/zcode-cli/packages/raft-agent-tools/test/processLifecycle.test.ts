/**
 * 共享的 stdio 进程守护（@zcode/shared/node/stdio-process-lifecycle，node-repl-host 同用）在
 * raft-agent-tools 入口下的行为：输出管道关闭即收尾、其余异步错误降级为带前缀的诊断。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  installStdioProcessGuards,
  installStdioShutdownTriggers,
} from "@zcode/shared/node/stdio-process-lifecycle";

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test("进程守护：EPIPE/EIO 等输出关闭错误只触发一次收尾，不再写诊断", () => {
  const proc = new EventEmitter();
  const writes: string[] = [];
  let closed = 0;
  installStdioProcessGuards({
    label: "raft_agent_tools",
    onOutputClosed: () => {
      closed += 1;
    },
    process: proc as unknown as NodeJS.Process,
    writeStderr: (text) => writes.push(text),
  });
  proc.emit("uncaughtException", errno("EIO"));
  proc.emit("uncaughtException", errno("EPIPE"));
  proc.emit("unhandledRejection", new Error("after close"));
  assert.equal(closed, 1);
  assert.deepEqual(writes, []);
});

test("进程守护：普通异步错误写带前缀的诊断，进程保留", () => {
  const proc = new EventEmitter();
  const writes: string[] = [];
  installStdioProcessGuards({
    label: "raft_agent_tools",
    onOutputClosed: () => assert.fail("不应收尾"),
    process: proc as unknown as NodeJS.Process,
    writeStderr: (text) => writes.push(text),
  });
  proc.emit("unhandledRejection", new Error("boom"));
  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? "", /^raft_agent_tools unhandledRejection \(process kept alive\): Error: boom/);
});

test("收尾触发：stdin 结束、关闭与信号只收尾一次", () => {
  const proc = new EventEmitter();
  const stdin = new EventEmitter();
  let shutdowns = 0;
  installStdioShutdownTriggers({
    process: proc as unknown as NodeJS.Process,
    shutdown: () => {
      shutdowns += 1;
    },
    stdin: stdin as unknown as NodeJS.ReadStream,
  });
  stdin.emit("end");
  stdin.emit("close");
  proc.emit("SIGTERM");
  assert.equal(shutdowns, 1);
});
