/**
 * app 层端口：副作用边界。app 通过这些接口决定行为，adapters 负责执行。
 * domain 保持纯函数；这里出现的都是可注入的 IO 面。
 */

/** CLI 检测结果。 */
export type RaftCliResolution =
  | { ok: true; cliPath: string; version: string }
  | { ok: false; code: "CliMissing" | "CliVersionUnsupported"; detail?: string };

/** 登录/核验结果；code 对应 raft CLI 的 stderr Code 分类（T0 已核实）。 */
export type RaftCliLoginOutcome =
  | { ok: true; agentName: string | undefined }
  | {
      ok: false;
      code: "TokenInvalid" | "IdentityMismatch" | "CredentialCheckFailed";
      detail?: string;
    };

export interface RaftCliWhoami {
  agentId: string;
  serverUrl: string;
  serverId: string;
}

/** 官方 raft CLI 适配端口（净化环境子进程，实现见 adapters/raftCli.ts）。 */
export interface RaftCliPort {
  /** 解析 CLI 路径并校验版本（最低 0.0.24，入口 dist/index.js 语义）。 */
  resolve(): Promise<RaftCliResolution>;
  /**
   * token 登录：`raft agent login --server --agent --profile-slug --profile-dir`，
   * token 经 stdin 单行传入；成功时从 stdout 解析 agentName（grep-stable 文案）。
   */
  login(params: {
    origin: string;
    expectedAgentId: string;
    profileSlug: string;
    profileDir: string;
    token: string;
  }): Promise<RaftCliLoginOutcome>;
  /** `raft auth whoami`（恒 JSON，token 不回显）——身份二次核验与 serverId 来源。 */
  whoami(params: {
    profileSlug: string;
    profileDir: string;
  }): Promise<RaftCliWhoami | { error: string }>;
  /**
   * 删除本地 profile 目录（登录成功后的失败路径防孤儿凭据）。
   * profilesRoot 用于包含性防护：profileDir 不在其内则拒绝删除。
   * 容错：目录不存在视为成功；失败向上抛由调用方决定是否吞掉。
   */
  destroyProfile(params: { profileDir: string; profilesRoot: string }): Promise<void>;
}

/**
 * 唤醒请求体（raft-channel-wake.v1，bridge → loopback POST；无消息正文）。
 * T0 已核实 raft-source f7682db 的 wire 契约。
 */
export interface RaftWakeRequest {
  schema: "raft-channel-wake.v1";
  attemptId: string;
  eventId: string;
  messageId: string;
  agentId: string;
  profile: string;
  coreSessionId: string;
  adapterInstance: string;
  occurredAt: string;
}

/** 单次唤醒的处理结果；HTTP 层只做协议映射，业务链（fencing/幂等/入队）在实现方。 */
export type WakeDelivery =
  /** CommandInbox 已接受命令（确认后才是 accepted）；重复 messageId 也算（幂等重放）。 */
  | { kind: "accepted"; runtimeSession: string }
  | { kind: "busy"; retryAfterMs: number }
  | { kind: "authRevoked" }
  | { kind: "noSession" }
  | { kind: "protocolMismatch" }
  | { kind: "injectionFailed"; detail?: string };

/** 唤醒处理端口：主会话适配器实现（T3 后半）；唤醒 HTTP 层在协议校验后调用。 */
export interface WakeHandlerPort {
  handleWake(input: { bindingId: string; wake: RaftWakeRequest }): Promise<WakeDelivery>;
}

/*
 * WakeEndpointPort 已统一到 app/bridgePorts.ts（单一事实源，锁定签名含 expectedAgentId
 * 与重入换 token）；实现见 adapters/wakeServer.ts（另扩展 listeningAddress 供诊断）。
 */

/** 会话投递结果（经 IZCodeTaskService 门面提交 v4 队列输入）；映射规则见 adapters/zcodeSession.ts。 */
export type RaftSessionSendOutcome =
  | { ok: true; /** true = CommandInbox 判 duplicate（幂等重放），仍视为成功。 */ duplicate: boolean }
  | {
      ok: false;
      /**
       * noSession = 会话目标已失效（stale / 未建会话）；rejected = 命令被拒（不可重试）；
       * transport = 传递层失败或执行失败（可退避重试，commandId 幂等保护重复提交）；
       * targetLost = 宿主内存 target 表未加载该会话（重启后未恢复 / 被外途归档），
       * 会话本身未必失效——唤醒链可按绑定上下文 resume 一次自愈后重投；
       * discardedOnRestart = 该命令编号对应的输入在 CLI 重启时被丢弃（ZCode 要求"确认后再发"），
       * 同一编号再发只会得到同一个失败结果——内容无正文的唤醒可换新编号重发一次。
       */
      code: "noSession" | "rejected" | "transport" | "targetLost" | "discardedOnRestart";
      detail?: string;
    };

/**
 * 主会话操作端口（T3 → R4）：唤醒投递经 IZCodeTaskService 门面的 sendPrompt
 * （内部 v4 sendText 队列语义）提交，幂等键 commandId 由调用方确定性派生
 * （wakeCycleId），经门面即 traceId。实现见 adapters/zcodeSession.ts。
 */
export interface RaftSessionPort {
  sendQueuedText(params: {
    workspacePath: string;
    sessionId: string;
    commandId: string;
    text: string;
  }): Promise<RaftSessionSendOutcome>;
  /**
   * 创建空主会话（绑定 provisioning 用；不发送任何输入，spec §4）。
   * officialMcpServers 是官方宿主 MCP 的具名引用（command/args 由 app-server 用自己的
   * 插件 rootPath 拼装，方案 1，线程 f3239b45）；agentMemory 指定记忆作用域 = Agent Home。
   * 两者均为启动期一次性注入，首发后不可补写（协议约束）。
   * 持久化语义：以 deferred 草稿创建（适配器固定传入），session 行由首个输入（V4
   * drain/wake）的统一持久化边界写入；immediate 缺省会让 V4 durable admission 跳过
   * 该边界，session_input 外键失败（e2e S4 根因）。
   * raftBindingId 在 tasks-index meta 上盖章绑定归属（B2/B3 按绑定归组）。
   */
  createAgentSession(params: {
    workspacePath: string;
    agentMemory: import("@zcode/shared").ZCodeAgentMemory;
    officialMcpServers: import("@zcode/shared").ZCodeOfficialMcpServerRef[];
    raftBindingId?: string;
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: "failed"; detail?: string }>;
  /**
   * 恢复主会话（值守开始用，spec §3：先完成会话恢复与 MEMORY 校验再启动 bridge）。
   * 冷恢复会重建 runtime，agentMemory 与 officialMcpServers 必须随 resume 再次下发
   * （缺失会退回项目记忆且无 Raft 工具）。失败不置 ErrorPaused（非本机故障语义），
   * 由调用方决定重试时机。raftBindingId 会在 pre-会话恢复时补写归属标记。
   */
  resumeAgentSession(params: {
    workspacePath: string;
    sessionId: string;
    agentMemory: import("@zcode/shared").ZCodeAgentMemory;
    officialMcpServers: import("@zcode/shared").ZCodeOfficialMcpServerRef[];
    raftBindingId?: string;
  }): Promise<{ ok: true } | { ok: false; code: "failed"; detail?: string }>;
  /**
   * 关闭主会话（二期 A1 删除动作）：session/close RPC——停 runtime 并归档产品会话。
   * 不做跨进程删库行；失败由调用方决定是否继续（绑定删除的语义优先）。
   */
  closeAgentSession(params: { workspacePath: string; sessionId: string }): Promise<{ ok: true } | { ok: false; code: "failed"; detail?: string }>;
  /**
   * 二期 B2：订阅主会话的活动事件（任务服务 onDynamicTaskEvent 的宿主侧订阅，归一成
   * 下面的最小事件面）。只供活动摘要展示，不改变任何任务状态。可选：测试替身可不实现。
   */
  subscribeActivity?(
    params: { workspacePath: string; sessionId: string },
    listener: (event: RaftSessionActivityEvent) => void,
  ): { dispose(): void };
}

/** 本机凭据目录枚举结果（apiKey 已在适配器内丢弃，永不进此结构）。 */
export interface RaftLocalProfileEntry {
  profileSlug: string;
  serverUrl: string;
  serverId: string;
  agentId: string;
  agentName?: string;
  createdAt: string;
  /** 缺省 = ZCode 自有；slock = Raft 命令行 profile（profileSlug 带 `slock:` 前缀）。 */
  source?: "zcode" | "slock";
  /** 该 agent 在本机已有 Raft daemon 托管目录（<slockHome>/agents/<agentId>）。 */
  hostedByRaftDaemon?: boolean;
}

/**
 * 本机已有凭据枚举端口（二期 A1，向导复用凭据列表的数据源）。
 * 实现读 raft/profiles 下各 profile 的 credential.json 非敏感字段；解析即弃 apiKey。
 */
export interface RaftProfilesCatalogPort {
  /** 列出本机全部凭据；跳过临时核验目录（verify- 前缀）与解析失败的条目。 */
  list(): Promise<RaftLocalProfileEntry[]>;
  /**
   * 复用凭据接入（二期 A2 服务面）：读出该 profile 的 token。token 只允许直达
   * 官方 CLI 的 stdin（与表单直传同链路），不进日志/返回值/持久化结构——调用方
   * 负责用后即弃。slug 做格式校验 + profilesRoot realpath 包含守卫。
   */
  resolveProfileToken(params: {
    profileSlug: string;
  }): Promise<
    { ok: true; token: string } | { ok: false; code: "Missing" | "Unreadable" | "HostedByRaftDaemon" }
  >;
}

/** 绑定记录存储端口（实现见 adapters/bindingStore.ts）。 */
export interface RaftBindingStorePort {
  readAll(): Promise<import("@zcode/shared").RaftAgentBinding[]>;
  /** 全量写回（原子）；写入方负责唯一性校验（域函数）。 */
  writeAll(bindings: import("@zcode/shared").RaftAgentBinding[]): Promise<void>;
}

/**
 * 主会话活动事件（二期 B2）：由会话适配器从 ZCodeStreamEvent 归一而来。
 * progressText 是本机界面用的一行进度（工具标题/命令等，只在 ZCode 本机展示，
 * 不转发 Raft）；转发 Raft 的只有工具名、状态、耗时、错误码。
 */
export type RaftSessionActivityEvent =
  | { kind: "turnStarted"; at: number }
  | { kind: "toolStarted"; at: number; toolId: string; toolName: string; progressText: string | null }
  | {
      kind: "toolFinished";
      at: number;
      toolId: string;
      toolName: string;
      status: "completed" | "failed" | "denied" | "stopped";
      progressText: string | null;
    }
  | { kind: "progress"; at: number; progressText: string }
  | { kind: "turnCompleted"; at: number }
  | { kind: "turnFailed"; at: number; errorCode: string | null }
  | { kind: "permissionRequested"; at: number }
  | { kind: "permissionResolved"; at: number };

/** 时钟端口：可测试的当前时间。 */
export interface ClockPort {
  nowIso(): string;
}

/** 首期支持的最低 raft CLI 版本（T0 实测通过版本，spec §4）。 */
export const MINIMUM_RAFT_CLI_VERSION = "0.0.24";
