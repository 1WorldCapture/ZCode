/**
 * Raft Agent 绑定：类型与运行时 schema 的唯一事实源。
 *
 * 一条绑定 = 一个 Raft Agent 身份在 ZCode 中的接入记录（第一期 spec §2）。
 * renderer 桥与 main 共用；持久化文件由 services 侧 RaftAgentsService 写入，
 * 本文件只描述数据形状，不包含任何 Node IO。token 本体永不出现在这些结构里。
 */
import { z } from "zod";

/** 绑定的期望值守状态；实际运行态是派生投影，不持久化。 */
export const raftAgentDesiredStateSchema = z.enum(["ReadyStopped", "Running"]);
export type RaftAgentDesiredState = z.infer<typeof raftAgentDesiredStateSchema>;

/** 主会话引用：换代 +1，旧代次的迟到回调会被拒绝（spec §6 fencing）。 */
export const raftAgentMainSessionRefSchema = z
  .object({
    sessionId: z.string().min(1),
    sessionGeneration: z.number().int().min(1),
  })
  .strict();
export type RaftAgentMainSessionRef = z.infer<typeof raftAgentMainSessionRefSchema>;

/**
 * Agent ID 的规范校验（RFC 9562 UUID，含 nil/max 特例）。
 * 绑定 schema 与表单输入 schema 共用同一事实源，防止两侧"什么算合法 UUID"语义漂移。
 */
export const raftAgentIdSchema = z.uuid();
export type RaftAgentId = z.infer<typeof raftAgentIdSchema>;

/** 绑定记录（应用管理数据，非 Agent Home、非 UI store）。 */
export const raftAgentBindingSchema = z
  .object({
    /** 稳定 UUID，创建后不变。 */
    bindingId: z.uuid(),
    /** 显示名（登录身份返回的 agentName，解析失败回退 agentId）。 */
    displayName: z.string().min(1),
    /** 规范化服务地址：去尾斜杠、小写 host。 */
    raftOrigin: z.string().url(),
    /** 登录时核验得到。 */
    serverId: z.string().min(1),
    /** 期望 Agent ID；与登录核验结果必须一致。 */
    raftAgentId: raftAgentIdSchema,
    /** ZCode 生成的稳定 slug（不依赖显示名）。 */
    profileSlug: z.string().min(1),
    /** Agent Home 绝对路径；全局唯一（含前缀包含判断）。 */
    homeWorkspacePath: z.string().min(1),
    mainSessionRef: raftAgentMainSessionRefSchema.nullable(),
    desiredState: raftAgentDesiredStateSchema,
    /** 用户是否同意自动开始值守；第一期默认 false。 */
    autostartConsent: z.boolean(),
    /** = bindingId；bridge 的 --adapter-instance 用，绝不随机重生成。 */
    adapterInstance: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type RaftAgentBinding = z.infer<typeof raftAgentBindingSchema>;

/** bindings.json 持久化文件形状（version 只在破坏性变更时 +1 并写迁移）。 */
export const raftAgentsConfigFileSchema = z
  .object({ version: z.literal(1), bindings: z.array(raftAgentBindingSchema) })
  .strict();
export type RaftAgentsConfigFile = z.infer<typeof raftAgentsConfigFileSchema>;

/** 表单输入。token 只经 stdin 传给官方 CLI，不进任何持久化结构。 */
export const raftAgentBindingInputSchema = z
  .object({
    raftOrigin: z.string().trim().min(1),
    raftAgentId: z.string().trim().pipe(raftAgentIdSchema),
    token: z.string().min(1),
    homeWorkspacePath: z.string().trim().optional(),
  })
  .strict();
export type RaftAgentBindingInput = z.infer<typeof raftAgentBindingInputSchema>;

/** 接入流程错误码（spec：T1 失败语义表）。 */
export const raftAgentSetupErrorCodeSchema = z.enum([
  "CliMissing",
  "CliVersionUnsupported",
  "OriginInvalid",
  "AgentIdInvalid",
  "TokenInvalid",
  "IdentityMismatch",
  "CredentialCheckFailed",
  "PathConflict",
  "SlugConflict",
  /** 同一 (raftOrigin, serverId, raftAgentId) 身份已有绑定（区别于 slug 碰撞）。 */
  "AlreadyBound",
  /** Provisioning 步骤失败（步骤名在 detail）；步骤自身应保持幂等可重试。 */
  "ProvisioningFailed",
  "StoreWriteFailed",
]);
export type RaftAgentSetupErrorCode = z.infer<typeof raftAgentSetupErrorCodeSchema>;

/** 接入结果：成功返回绑定；失败返回错误码 + 已完成到的步骤（重试幂等）。 */
export const raftAgentSetupResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), binding: raftAgentBindingSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: raftAgentSetupErrorCodeSchema,
      /** 面向用户的补充信息（如冲突绑定的显示名、期望的最低版本）。 */
      detail: z.string().optional(),
    })
    .strict(),
]);
export type RaftAgentSetupResult = z.infer<typeof raftAgentSetupResultSchema>;

/** 连接状态（凭据健康，派生）。 */
export const raftAgentConnectionStateSchema = z.enum([
  "credential_ok",
  "credential_invalid",
  "unverified",
]);
export type RaftAgentConnectionState = z.infer<typeof raftAgentConnectionStateSchema>;

/**
 * 运行状态投影：ReadyStopped 表示用户暂停/从未开始；
 * ErrorPaused 携带原因，UI 必须与用户暂停可区分（spec §3/§10）。
 */
export const raftAgentRunStateSchema = z.union([
  z.enum(["ReadyStopped", "Starting", "Running", "Stopping"]),
  z
    .object({
      kind: z.literal("ErrorPaused"),
      reason: z.enum([
        "memory_unavailable",
        "credential_invalid",
        "bridge_exit",
        "inbox_log_write_failed",
      ]),
    })
    .strict(),
]);
export type RaftAgentRunState = z.infer<typeof raftAgentRunStateSchema>;

/** 列表行投影（派生态，不持久化；数据来自绑定记录 + 运行时状态源）。 */
export const raftAgentListItemSchema = z
  .object({
    bindingId: z.string().uuid(),
    displayName: z.string().min(1),
    raftOrigin: z.string().min(1),
    connectionState: raftAgentConnectionStateSchema,
    runState: raftAgentRunStateSchema,
    homePath: z.string().min(1),
  })
  .strict();
export type RaftAgentListItem = z.infer<typeof raftAgentListItemSchema>;
