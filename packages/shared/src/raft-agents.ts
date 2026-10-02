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

/**
 * 表单输入（二期 A2 起互斥二选一）：直传 token，或复用本机已有凭据
 * （existingProfileSlug——服务侧从该 profile 读 token 走与直传完全相同的链路；
 * 绑定本身仍生成自己的 ZCode slug，原 profile 不动）。token 只经 stdin 传给
 * 官方 CLI，不进任何持久化结构。
 */
const raftAgentBindingInputFields = {
  raftOrigin: z.string().trim().min(1),
  raftAgentId: z.string().trim().pipe(raftAgentIdSchema),
  homeWorkspacePath: z.string().trim().optional(),
};
/** 复用凭据的 slug：ZCode 自有 profile 为裸 slug；Raft 命令行（~/.slock/profiles）的带 `slock:` 前缀。 */
const EXISTING_PROFILE_SLUG_PATTERN = /^(slock:)?[a-z0-9][a-z0-9-]{0,63}$/;

export const raftAgentBindingInputSchema = z.union([
  z.object({ ...raftAgentBindingInputFields, token: z.string().min(1) }).strict(),
  z
    .object({
      ...raftAgentBindingInputFields,
      existingProfileSlug: z.string().regex(EXISTING_PROFILE_SLUG_PATTERN),
    })
    .strict(),
]);
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
  /**
   * 自定义 Home 包住（或落入）Raft 凭据目录（数据根下 raft/profiles，明文
   * sk_agent_*）。值守会话的文件工具被 confineFileToolsToWorkspace 锁在 Home 内，
   * Home 若覆盖凭据目录，频道消息即可读出凭据——创建时直接拒绝。
   */
  "HomeOverlapsCredentials",
  /** 同一 (raftOrigin, serverId, raftAgentId) 身份已有绑定（区别于 slug 碰撞）。 */
  "AlreadyBound",
  /**
   * 二期 A2：复用凭据接入时，existingProfileSlug 已被其他绑定引用占用
   * （与 listLocalCredentials.boundBindingId 同判据；UI 侧置灰，服务侧兜底）。
   */
  "ProfileInUse",
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
        // T3 增量：CLI 缺失/版本不符时无法拉起 bridge，按异常暂停呈现（枚举追加，
        // 旧读取方需容忍新值——reason 是展示用投影，不参与持久化判等）。
        "cli_unavailable",
        // 官方 MCP 插件不可用（fail-closed 不启动值守）/ 主会话恢复失败：
        // 不置值会一直投影成 Starting，用户看不到原因（评审 e04a5ee 线程 b51caf5c）。
        "mcp_unavailable",
        "session_unavailable",
        // 双消费保险之三（TinyCode 并排身份）：旧产品（ZCode）侧同一绑定仍在值守
        // （存活 pid 持锁），本产品拒绝启动值守（枚举追加，旧读取方容忍新值）。
        "legacy_watch_held",
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
    /**
     * Home 归属分类（host 用 resolveAgentHomeKind 探测后随投影下发；UI 只读不自算）：
     * default = 数据根 agents/<容器>/workspace 且归属标记匹配（容器名是预派发 UUID，
     * 不等于 bindingId）；custom = 用户自选目录（与旧产品共用，删除绑定时禁用「删除
     * Home」）；unknown-home = 位置像默认布局但归属标记缺失/不符。旧读取方不受影响。
     */
    homeKind: z.enum(["default", "custom", "unknown-home"]).optional(),
    /**
     * 主会话编号（B3 嵌入会话视图直达挂载）；null = 懒建未发生——冷恢复统一走
     * openAgentSession（绑定派生记忆 + 官方 MCP 的恢复/重建入口），不自行 resume。
     */
    mainSessionId: z.string().min(1).nullable(),
    /**
     * 二期 A1 活动投影（可选派生字段，旧读取方不受影响）。pendingApprovals 在
     * yolo 值守下恒 0（无人工审批面）；turn 级粒度待 B2 活动事件接入后追加字段。
     */
    activity: z
      .object({
        lastActivityAt: z.string().nullable(),
        lastActivityKind: z.enum(["wake", "drain_submitted", "error"]).nullable(),
        memoryLoaded: z.boolean(),
        pendingApprovals: z.number().int().min(0),
        /** 二期 B2：主会话处理状态（会话事件实时投影；值守未开始时缺省）。 */
        phase: z.enum(["idle", "working", "error"]).optional(),
        /** 二期 B2：当前事项（处理中最近一条工具/进度，本机展示用；空闲为 null）。 */
        currentItem: z.string().nullable().optional(),
        /** 二期 B2：待处理数（唤醒已投递进会话、尚未开始处理）。 */
        pendingCount: z.number().int().min(0).optional(),
        /** 二期 B2：最近一次处理出错（错误码 + 时间）。 */
        lastError: z.object({ code: z.string().nullable(), at: z.string() }).strict().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RaftAgentListItem = z.infer<typeof raftAgentListItemSchema>;

/**
 * 绑定存储健康态（损坏定向提示）：list() 失败时界面用 getStorageHealth() 拿到
 * 有形状的原因，不必解析异常文本。corrupt = fail-closed 已保全证据、原文件保留，
 * 等待用户手动恢复（绝不清空重建）。
 */
export const raftAgentStorageHealthSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  z
    .object({
      status: z.literal("corrupt"),
      /** 损坏的绑定记录文件路径（原样保留，未动）。 */
      storePath: z.string().min(1),
      /** 证据备份路径（内容寻址、幂等）；备份失败为 null——提示如实说明。 */
      backupPath: z.string().min(1).nullable(),
    })
    .strict(),
]);
export type RaftAgentStorageHealth = z.infer<typeof raftAgentStorageHealthSchema>;

/**
 * CLI 健康态（宿主环境健康的一部分）：向导进入时的前置检测投影。
 * 复用 RaftCliPort.resolve()（PATH 解析 + `--version`，不碰凭据）；
 * detail 是 exit code / 版本号 / stdout 截断等非敏感诊断片段，可为 null。
 */
export const raftAgentCliHealthSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      /** 实际解析到的 CLI 路径（显式 env 覆盖或 PATH 命中）。 */
      cliPath: z.string().min(1),
      /** `raft --version` 解析出的版本号（已过最低版本门禁）。 */
      version: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("CliMissing"), detail: z.string().nullable() }).strict(),
  z.object({ status: z.literal("CliVersionUnsupported"), detail: z.string().nullable() }).strict(),
]);
export type RaftAgentCliHealth = z.infer<typeof raftAgentCliHealthSchema>;

/**
 * 宿主环境健康：存储态 + CLI 态一次返回。Agent 中心 / 接入向导进入时调一次
 * 即可完成全部前置检查（列表损坏定向提示 + 未装命令行安装提示），不必逐项探测。
 */
export const raftAgentEnvironmentHealthSchema = z
  .object({
    storage: raftAgentStorageHealthSchema,
    cli: raftAgentCliHealthSchema,
  })
  .strict();
export type RaftAgentEnvironmentHealth = z.infer<typeof raftAgentEnvironmentHealthSchema>;

// -----------------------------------------------
// 二期 A1：管理动作 / 凭据预核验 / 记忆只读 / 凭据枚举
// -----------------------------------------------

/**
 * 凭据预核验输入：token 只经 stdin 进 CLI，不进任何持久化结构。凭据来源二选一
 * （与 createBinding 同款）：直传 token，或复用本机已有凭据 existingProfileSlug
 * （服务侧读出、读完即弃）——两种接入模式的确认页都能先核验身份再显示。
 */
export const raftAgentVerifyCredentialInputSchema = z
  .object({
    raftOrigin: z.string().trim().min(1),
    raftAgentId: z.string().trim().pipe(raftAgentIdSchema),
    /** 直传凭据；与 existingProfileSlug 恰好给一个。 */
    token: z.string().min(1).optional(),
    /** 复用本机已有凭据（A2）；与 token 恰好给一个。 */
    existingProfileSlug: z.string().regex(EXISTING_PROFILE_SLUG_PATTERN).optional(),
    /**
     * 可选 Home 路径：给了就形状校验后原样回显；留空返回服务端预派发的默认路径，
     * 向导保存时把它作为 homeWorkspacePath 显式回传（两侧共用同一派生函数）。
     */
    homeWorkspacePath: z.string().trim().optional(),
  })
  .strict()
  .refine((v) => (v.token !== undefined) !== (v.existingProfileSlug !== undefined), {
    message: "exactly one of token or existingProfileSlug is required",
  });
export type RaftAgentVerifyCredentialInput = z.infer<typeof raftAgentVerifyCredentialInputSchema>;

/** 预核验结果：成功返回服务端认定的身份；失败码与接入同族（无 Provisioning/Store 系）。 */
export const raftAgentVerifyResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      identity: z
        .object({
          agentId: raftAgentIdSchema,
          agentName: z.string().optional(),
          serverUrl: z.string().min(1),
          serverId: z.string().min(1),
        })
        .strict(),
      /**
       * 实际生效的 Home 完整路径（B1/A2 验收）：输入给了就回显（形状校验过），
       * 留空给服务端预派发默认——绑定 UUID 创建时才生成，这里先派发一个具体路径。
       */
      homePath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum([
        "CliMissing",
        "CliVersionUnsupported",
        "OriginInvalid",
        "AgentIdInvalid",
        "TokenInvalid",
        "IdentityMismatch",
        "CredentialCheckFailed",
        // 复用凭据预核验（与 createBinding 同款早失败）：确认页不该走到保存才报占用。
        "ProfileInUse",
        // 身份级占用预核验（收尾缺陷：AlreadyBound 到保存才暴露）：同源同 agent
        // （登录前）或同 serverId+agentId（登录后）已有绑定 → 定向提示占用者。
        "AlreadyBound",
      ]),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type RaftAgentVerifyResult = z.infer<typeof raftAgentVerifyResultSchema>;

/** 记忆面文件条目（只读视图）。path 限定 "MEMORY.md" | "AGENTS.md" | "notes/..."。 */
export const raftAgentMemoryFileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().min(0),
    modifiedAt: z.string().min(1),
  })
  .strict();
export type RaftAgentMemoryFile = z.infer<typeof raftAgentMemoryFileSchema>;

/** 记忆文件内容（truncated = 超过单文件上限被截断）。 */
export const raftAgentMemoryContentSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      content: z.string(),
      modifiedAt: z.string().min(1),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["NotFound", "OutsideMemorySurface", "Unreadable"]),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type RaftAgentMemoryContent = z.infer<typeof raftAgentMemoryContentSchema>;

/** 本机已有凭据条目（apiKey 永不出现；boundBindingId = 已被现有绑定占用）。 */
export const raftAgentLocalCredentialSchema = z
  .object({
    profileSlug: z.string().min(1),
    serverUrl: z.string().min(1),
    serverId: z.string().min(1),
    agentId: raftAgentIdSchema,
    agentName: z.string().optional(),
    createdAt: z.string().min(1),
    boundBindingId: z.string().uuid().nullable(),
    /** 凭据来源：缺省 = ZCode 自有（raft/profiles）；slock = Raft 命令行（~/.slock/profiles）。 */
    source: z.enum(["zcode", "slock"]).optional(),
    /** 该 agent 正由本机 Raft daemon 托管：复用会造成同一身份两处同时值守，界面置灰并说明原因。 */
    hostedByRaftDaemon: z.boolean().optional(),
  })
  .strict();
export type RaftAgentLocalCredential = z.infer<typeof raftAgentLocalCredentialSchema>;

/** 管理动作（重启/重置）结果。 */
export const raftAgentManagementResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["NotFound", "SessionCreateFailed", "MemoryResetFailed"]),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type RaftAgentManagementResult = z.infer<typeof raftAgentManagementResultSchema>;

/** 打开会话（B3 恢复入口）结果：返回会话坐标供渲染层挂现有会话视图。 */
export const raftAgentOpenSessionResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string().min(1),
      workspacePath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["NotFound", "McpUnavailable", "SessionCreateFailed", "SessionResumeFailed"]),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type RaftAgentOpenSessionResult = z.infer<typeof raftAgentOpenSessionResultSchema>;

/**
 * 删除绑定时 Home 目录处置结果（removeBinding 返回；界面按态如实提示）。
 * failed 单列：递归删除/清理中途失败时 Home 可能已被删一部分，不能声称未改动。
 */
export const raftAgentRemoveHomeOutcomeSchema = z.discriminatedUnion("home", [
  /** 整目录已删；ENOENT 也归此（终态等价：目录不存在）。 */
  z.object({ home: z.literal("deleted") }).strict(),
  /** 归属不成立：只清了记忆三处与标记，目录保留。 */
  z.object({ home: z.literal("kept_memory_cleared") }).strict(),
  /** 确实未动过 Home：没请求删除，或被守卫拒绝（符号链接/受保护根等）。 */
  z
    .object({
      home: z.literal("untouched"),
      reason: z.enum(["not_requested", "refused"]),
      detail: z.string().optional(),
    })
    .strict(),
  /** 处置中途失败：Home 可能已部分删除/部分清理，请手动检查。 */
  z
    .object({ home: z.literal("failed"), detail: z.string().optional() })
    .strict(),
]);
export type RaftAgentRemoveHomeOutcome = z.infer<typeof raftAgentRemoveHomeOutcomeSchema>;
