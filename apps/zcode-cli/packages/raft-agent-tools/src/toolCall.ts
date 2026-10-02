// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * Raft 工具调用的纯校验与 argv 构造域（无 IO、无 await）。
 *
 * 安全要点（spec §6）：身份参数「构造而非过滤」——argv 前缀由适配器固定
 * （`--profile <slug>`），业务参数只来自下面这些结构化字段，
 * 不存在「过滤调用方传入的参数串」的路径。所有取值统一用 `--flag=value`
 * 形式，取值即使以 `-` 开头也不可能被当成另一个选项。
 */

/** 白名单工具名（与 MCP 工具名一一对应）。 */
export type RaftToolName =
  | "message_check"
  | "message_read"
  | "message_send"
  | "task_list"
  | "task_claim"
  | "task_update"
  | "server_info"
  | "channel_members";

/** task update 只放行这两个状态：完成只置 in_review，由人验收后才 done。 */
export const ALLOWED_TASK_UPDATE_STATUSES = ["in_progress", "in_review"] as const;
export type AllowedTaskUpdateStatus = (typeof ALLOWED_TASK_UPDATE_STATUSES)[number];

const TASK_LIST_STATUSES = ["all", "todo", "in_progress", "in_review", "done", "closed"] as const;
type TaskListStatus = (typeof TASK_LIST_STATUSES)[number];

export type RaftToolCall =
  | { tool: "message_check" }
  | {
      tool: "message_read";
      target: string;
      after?: string;
      before?: string;
      around?: string;
      limit?: number;
    }
  | { tool: "message_send"; target: string; content?: string; sendDraft?: boolean }
  | { tool: "task_list"; target?: string; mine?: boolean; status?: TaskListStatus }
  | { tool: "task_claim"; target: string; numbers: number[] }
  | { tool: "task_update"; target: string; number: number; status: string }
  // 只读发现面（PM 7b0d34bd 批准）：复用官方 CLI 的 server info / channel members，
  // 解决"不知道频道名、误把未创建的 DM 当读目标"的缺口。
  | { tool: "server_info" }
  | { tool: "channel_members"; target: string };

/** 构造结果：argv 不含 CLI 可执行文件本身。 */
export type BuiltCommand =
  | { ok: true; argv: string[]; stdin?: string; timeoutMs: number }
  | { ok: false; reason: string };

/** 正文上限：保护本机进程与日志，服务端另有自己的限制。 */
export const MAX_MESSAGE_CONTENT_CHARS = 50_000;

const READ_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 60_000;

// 频道 `#name`、私信 `dm:@name`，可选线程后缀 `:shortid`。
const TARGET_PATTERN =
  /^(?:#[A-Za-z0-9][A-Za-z0-9._-]*|dm:@[A-Za-z0-9][A-Za-z0-9._-]*)(?::[0-9a-fA-F-]{6,36})?$/;
const CHANNEL_TARGET_PATTERN = /^#[A-Za-z0-9][A-Za-z0-9._-]*$/;
// 消息 id 短/长形式，或纯数字 seq。
const ANCHOR_PATTERN = /^(?:[0-9]{1,12}|[0-9a-fA-F-]{8,36})$/;

function reject(reason: string): BuiltCommand {
  return { ok: false, reason };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

/** 校验并构造子命令 argv（不含 `--profile` 前缀，前缀由适配器固定加上）。 */
export function buildRaftCommand(call: RaftToolCall): BuiltCommand {
  switch (call.tool) {
    case "message_check":
      return { ok: true, argv: ["message", "check"], timeoutMs: READ_TIMEOUT_MS };

    case "message_read": {
      if (!TARGET_PATTERN.test(call.target)) return reject("target 格式无效");
      const argv = ["message", "read", `--target=${call.target}`];
      for (const key of ["after", "before", "around"] as const) {
        const value = call[key];
        if (value === undefined) continue;
        if (!ANCHOR_PATTERN.test(value)) return reject(`${key} 必须是消息 id 或序号`);
        argv.push(`--${key}=${value}`);
      }
      if (call.limit !== undefined) {
        if (!isPositiveInt(call.limit) || call.limit > 200)
          return reject("limit 必须是 1–200 的整数");
        argv.push(`--limit=${call.limit}`);
      }
      return { ok: true, argv, timeoutMs: READ_TIMEOUT_MS };
    }

    case "message_send": {
      if (!TARGET_PATTERN.test(call.target)) return reject("target 格式无效");
      const argv = ["message", "send", `--target=${call.target}`];
      if (call.sendDraft === true) {
        // 发送已保存的草稿：CLI 约定此时不带正文（改稿请直接重发新正文）。
        if (call.content !== undefined) return reject("sendDraft 与 content 不能同时提供");
        argv.push("--send-draft");
        return { ok: true, argv, timeoutMs: SEND_TIMEOUT_MS };
      }
      if (typeof call.content !== "string" || call.content.trim().length === 0)
        return reject("content 不能为空");
      if (call.content.length > MAX_MESSAGE_CONTENT_CHARS) return reject("content 过长");
      // 正文只经 stdin（`--content` 在 CLI 中不受支持）。
      return { ok: true, argv, stdin: call.content, timeoutMs: SEND_TIMEOUT_MS };
    }

    case "task_list": {
      const argv = ["task", "list"];
      if (call.target !== undefined) {
        if (!CHANNEL_TARGET_PATTERN.test(call.target)) return reject("task 的 target 必须是频道");
        argv.push(`--target=${call.target}`);
      }
      if (call.mine === true) argv.push("--mine");
      if (call.target === undefined && call.mine !== true) return reject("需要 target 或 mine");
      if (call.status !== undefined) {
        if (!(TASK_LIST_STATUSES as readonly string[]).includes(call.status))
          return reject("status 无效");
        argv.push(`--status=${call.status}`);
      }
      return { ok: true, argv, timeoutMs: READ_TIMEOUT_MS };
    }

    case "task_claim": {
      if (!CHANNEL_TARGET_PATTERN.test(call.target)) return reject("task 的 target 必须是频道");
      if (!Array.isArray(call.numbers) || call.numbers.length === 0 || call.numbers.length > 20) {
        return reject("numbers 需要 1–20 个任务编号");
      }
      if (!call.numbers.every(isPositiveInt)) return reject("任务编号必须是正整数");
      const argv = ["task", "claim", `--target=${call.target}`];
      for (const n of call.numbers) argv.push(`--number=${n}`);
      return { ok: true, argv, timeoutMs: READ_TIMEOUT_MS };
    }

    case "task_update": {
      if (!CHANNEL_TARGET_PATTERN.test(call.target)) return reject("task 的 target 必须是频道");
      if (!isPositiveInt(call.number)) return reject("任务编号必须是正整数");
      if (!(ALLOWED_TASK_UPDATE_STATUSES as readonly string[]).includes(call.status)) {
        return reject("只允许置为 in_progress 或 in_review；完成由人验收后置 done");
      }
      return {
        ok: true,
        argv: [
          "task",
          "update",
          `--target=${call.target}`,
          `--number=${call.number}`,
          `--status=${call.status}`,
        ],
        timeoutMs: READ_TIMEOUT_MS,
      };
    }

    case "server_info":
      // 官方 CLI 的人读输出直接交给模型（与 message_read 同一策略，不另做解析）。
      return { ok: true, argv: ["server", "info"], timeoutMs: READ_TIMEOUT_MS };

    case "channel_members": {
      // CLI 定义为位置参数（raft-source channel/members.ts：<target>）。校验后必以
      // `#` 开头，不可能被当成选项——这是全文件唯一非 `--flag=value` 的取值位置。
      if (!CHANNEL_TARGET_PATTERN.test(call.target)) return reject("target 必须是频道");
      return { ok: true, argv: ["channel", "members", call.target], timeoutMs: READ_TIMEOUT_MS };
    }

    default:
      return reject("不在白名单内的工具");
  }
}

/** 从 `raft message check` 的规范文本里提取消息 id 与目标（仅用于日志索引，不改正文）。 */
export function parseCheckedMessages(text: string): { messageIds: string[]; targets: string[] } {
  const messageIds: string[] = [];
  const targets = new Set<string>();
  for (const match of text.matchAll(/^\[target=(\S+)\s+msg=(\S+)/gm)) {
    const target = match[1];
    const id = match[2];
    if (target) targets.add(target);
    if (id) messageIds.push(id);
  }
  return { messageIds, targets: [...targets] };
}

/** fork 命令行 `message claim` 末尾的确认凭据行（固定前缀、单行）。 */
export const CLAIM_ACK_LINE = /^Claim-Ack: [A-Za-z0-9_-]+$/;

export interface ClaimedText {
  /** 确认凭据行（整行，含前缀）；没有消息时为 undefined。 */
  ackLine?: string;
  /** 逐条消息块：以 `[target=` 行起头，续行（多行正文）归入同一块。 */
  blocks: { target: string; messageId: string; text: string }[];
  /** 服务端还有更多待取消息。 */
  hasMore: boolean;
}

/**
 * 拆解 `message claim` 的规范文本：剥除 `Claim-Ack:` 行与状态行，按消息切块。
 * 只用于确认与去重；交给模型的文本由 `renderClaimedText` 重新拼出。
 */
export function parseClaimedText(text: string): ClaimedText {
  let ackLine: string | undefined;
  let hasMore = false;
  const blocks: ClaimedText["blocks"] = [];
  for (const line of text.split("\n")) {
    if (CLAIM_ACK_LINE.test(line.trim())) {
      ackLine = line.trim();
      continue;
    }
    if (line.startsWith("More messages are pending.")) {
      hasMore = true;
      continue;
    }
    if (/^No (?:more )?new inbox messages\.$/.test(line.trim())) continue;
    const header = /^\[target=(\S+)\s+msg=(\S+)/.exec(line);
    if (header?.[1] && header[2]) {
      blocks.push({ target: header[1], messageId: header[2], text: line });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last) last.text += `\n${line}`;
  }
  for (const block of blocks) block.text = block.text.replace(/\n+$/, "");
  return { ackLine, blocks, hasMore };
}

/** 交给模型的文本：只含新消息块与状态行，不含确认凭据。 */
export function renderClaimedText(blocks: ClaimedText["blocks"], hasMore: boolean): string {
  const status = hasMore
    ? "More messages are pending. Call raft_message_check again."
    : blocks.length > 0
      ? "No more new inbox messages."
      : "No new inbox messages.";
  return blocks.length > 0 ? `${blocks.map((b) => b.text).join("\n")}\n\n${status}\n` : `${status}\n`;
}
