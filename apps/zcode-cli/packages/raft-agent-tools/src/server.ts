/**
 * Raft Agent 工具 MCP 服务（stdio，session 隔离）。
 *
 * 每个会话由宿主拉起一个独立进程，身份（binding / profile）来自启动环境，
 * 模型侧的工具入参里没有任何身份字段。本进程是收件日志的唯一写者。
 */
import { Server, type Tool } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CliToolAdapter, RaftToolResult } from "./cliToolAdapter.js";
import type { RaftToolCall, RaftToolName } from "./toolCall.js";

export const RAFT_TOOLS_SERVER_NAME = "raft_agent_tools";
export const RAFT_TOOLS_SERVER_VERSION = "0.1.0";

export const RAFT_TOOLS_SERVER_INSTRUCTIONS = [
  "这些工具以你自己的 Raft 身份操作 Raft（读消息、发消息、处理任务）；身份已固定，无法更改。",
  "收到唤醒后先用 raft_message_check 读取你的收件箱，再决定回复或处理任务。",
  "回复只能通过 raft_message_send 发出，并明确 target；普通输出不会发送到 Raft。",
  "私信（dm:@名字）直接用 raft_message_send 发送，首条消息会自动创建私信；读不到未创建的私信不是错误。不确定频道或成员名时先用 raft_server_info / raft_channel_members 查。",
  "发送前如果目标里有你没读过的新消息，消息会被存为草稿而不发出：先阅读返回的新消息，再决定发原稿（sendDraft:true）、改稿重发或放弃。",
  "发送结果不确定时不要重发，说明情况并等待人核对。",
  "完成任务后把状态置为 in_review，由人验收；你不能把任务置为 done。",
].join("\n");

const targetSchema = z.string().describe("目标：'#频道'、'dm:@对方'，线程加 ':线程短id'");
const anchorSchema = z.string().describe("消息 id（短或长）或纯数字序号");

const toolSchemas = {
  raft_message_check: z.object({}).strict(),
  raft_message_read: z
    .object({
      target: targetSchema,
      after: anchorSchema.optional(),
      before: anchorSchema.optional(),
      around: anchorSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  raft_message_send: z
    .object({
      target: targetSchema,
      content: z.string().optional().describe("消息正文；与 sendDraft 互斥"),
      sendDraft: z.boolean().optional().describe("true 表示发送此前被扣下的草稿（不带 content）"),
    })
    .strict(),
  raft_task_list: z
    .object({
      target: z.string().optional().describe("频道，如 '#dev'"),
      mine: z.boolean().optional().describe("只列分配给自己的任务"),
      status: z.enum(["all", "todo", "in_progress", "in_review", "done", "closed"]).optional(),
    })
    .strict(),
  raft_task_claim: z
    .object({ target: z.string().describe("频道，如 '#dev'"), numbers: z.array(z.number().int().positive()).min(1).max(20) })
    .strict(),
  raft_task_update: z
    .object({
      target: z.string().describe("频道，如 '#dev'"),
      number: z.number().int().positive(),
      status: z.enum(["in_progress", "in_review"]).describe("只能置为 in_progress 或 in_review；完成由人验收"),
    })
    .strict(),
  raft_server_info: z.object({}).strict(),
  raft_channel_members: z
    .object({
      target: z.string().describe("频道名，如 '#dev'"),
    })
    .strict(),
} as const;

type ToolKey = keyof typeof toolSchemas;

const toolDescriptions: Record<ToolKey, string> = {
  raft_message_check: "读取你的 Raft 收件箱（新消息、@提及、私信）。已读到的消息不会重复出现。",
  raft_message_read: "读取某个频道、私信或线程的历史消息。",
  raft_message_send: "以你的身份向频道、私信或线程发送消息。发送前若有你没读过的新消息，会存为草稿并返回新消息。",
  raft_task_list: "列出频道里的任务，或你自己的任务。",
  raft_task_claim: "认领一个或多个任务（按任务编号）。",
  raft_task_update: "更新任务状态（只能置为 in_progress 或 in_review）。",
  raft_server_info: "查看你所在服务器的频道与成员（agent 和人）等只读信息。不确定频道名、想找某个人时先用它。",
  raft_channel_members: "列出某个频道的成员（agent 和人）。",
};

const toolNameToInternal: Record<ToolKey, RaftToolName> = {
  raft_message_check: "message_check",
  raft_message_read: "message_read",
  raft_message_send: "message_send",
  raft_task_list: "task_list",
  raft_task_claim: "task_claim",
  raft_task_update: "task_update",
  raft_server_info: "server_info",
  raft_channel_members: "channel_members",
};

export function listRaftTools(): Tool[] {
  return (Object.keys(toolSchemas) as ToolKey[]).map((key) => ({
    name: key,
    description: toolDescriptions[key],
    inputSchema: z.toJSONSchema(toolSchemas[key]) as Tool["inputSchema"],
  }));
}

/** 把模型入参映射为核心的结构化调用；校验失败返回错误文本。 */
export function toToolCall(name: string, args: unknown): { ok: true; call: RaftToolCall } | { ok: false; error: string } {
  if (!Object.hasOwn(toolSchemas, name)) return { ok: false, error: `未知工具：${name}` };
  const key = name as ToolKey;
  const parsed = toolSchemas[key].safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `入参无效：${parsed.error.issues.map((i) => i.message).join("；")}` };
  return { ok: true, call: { tool: toolNameToInternal[key], ...(parsed.data as object) } as RaftToolCall };
}

type McpText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: string, isError = false): McpText {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/** 把适配器结果翻成模型能直接据此行动的文本。 */
export function formatToolResult(result: RaftToolResult): McpText {
  switch (result.kind) {
    case "ok":
      return text(result.text.trim().length > 0 ? result.text : "(无输出)");
    case "held":
      return text(
        [
          "消息没有发出：目标里有你还没读过的新消息，你的回复已存为草稿。",
          "请先阅读下面的内容，再选择：发送原稿（raft_message_send，sendDraft:true）、改稿后重新发送，或放弃。",
          "",
          result.text,
        ].join("\n"),
      );
    case "unknown":
      return text(`发送结果不确定，请不要重发；向人说明情况并等待核对。\n\n${result.text}`, true);
    case "error":
      return text(result.text || "命令失败", true);
    case "rejected":
      return text(`参数被拒绝：${result.reason}`, true);
  }
}

export function createRaftToolsServer(adapter: CliToolAdapter): Server {
  const server = new Server(
    { name: RAFT_TOOLS_SERVER_NAME, version: RAFT_TOOLS_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: RAFT_TOOLS_SERVER_INSTRUCTIONS },
  );
  const tools = listRaftTools();
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request) => {
    const mapped = toToolCall(request.params.name, request.params.arguments);
    if (!mapped.ok) return text(mapped.error, true);
    return formatToolResult(await adapter.invoke(mapped.call));
  });
  return server;
}
