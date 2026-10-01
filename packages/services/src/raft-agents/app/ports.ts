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

/** V4 sendText(queue) 的提交结果；映射规则见 adapters/zcodeSession.ts。 */
export type RaftSessionSendOutcome =
  | { ok: true; /** true = CommandInbox 判 duplicate（幂等重放），仍视为成功。 */ duplicate: boolean }
  | {
      ok: false;
      /**
       * noSession = 会话目标已失效（stale / 未建会话）；rejected = 命令被拒（不可重试）；
       * transport = 传递层失败或执行失败（可退避重试，commandId 幂等保护重复提交）。
       */
      code: "noSession" | "rejected" | "transport";
      detail?: string;
    };

/**
 * 主会话操作端口（T3）：唤醒投递经 V4 sendText（requestedDelivery "queue"）提交，
 * 幂等键 commandId 由调用方确定性派生（wakeCycleId）。实现见 adapters/zcodeSession.ts。
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
   */
  createAgentSession(params: {
    workspacePath: string;
    agentMemory: import("@zcode/shared").ZCodeAgentMemory;
    officialMcpServers: import("@zcode/shared").ZCodeOfficialMcpServerRef[];
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: "failed"; detail?: string }>;
  /**
   * 恢复主会话（值守开始用，spec §3：先完成会话恢复与 MEMORY 校验再启动 bridge）。
   * 冷恢复会重建 runtime，agentMemory 与 officialMcpServers 必须随 resume 再次下发
   * （缺失会退回项目记忆且无 Raft 工具）。失败不置 ErrorPaused（非本机故障语义），
   * 由调用方决定重试时机。
   */
  resumeAgentSession(params: {
    workspacePath: string;
    sessionId: string;
    agentMemory: import("@zcode/shared").ZCodeAgentMemory;
    officialMcpServers: import("@zcode/shared").ZCodeOfficialMcpServerRef[];
  }): Promise<{ ok: true } | { ok: false; code: "failed"; detail?: string }>;
  /**
   * 关闭主会话（二期 A1 删除动作）：session/close RPC——停 runtime 并归档产品会话。
   * 不做跨进程删库行；失败由调用方决定是否继续（绑定删除的语义优先）。
   */
  closeAgentSession(params: { workspacePath: string; sessionId: string }): Promise<{ ok: true } | { ok: false; code: "failed"; detail?: string }>;
}

/** 本机凭据目录枚举结果（apiKey 已在适配器内丢弃，永不进此结构）。 */
export interface RaftLocalProfileEntry {
  profileSlug: string;
  serverUrl: string;
  serverId: string;
  agentId: string;
  agentName?: string;
  createdAt: string;
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
  }): Promise<{ ok: true; token: string } | { ok: false; code: "Missing" | "Unreadable" }>;
}

/** 绑定记录存储端口（实现见 adapters/bindingStore.ts）。 */
export interface RaftBindingStorePort {
  readAll(): Promise<import("@zcode/shared").RaftAgentBinding[]>;
  /** 全量写回（原子）；写入方负责唯一性校验（域函数）。 */
  writeAll(bindings: import("@zcode/shared").RaftAgentBinding[]): Promise<void>;
}

/** 时钟端口：可测试的当前时间。 */
export interface ClockPort {
  nowIso(): string;
}

/** 首期支持的最低 raft CLI 版本（T0 实测通过版本，spec §4）。 */
export const MINIMUM_RAFT_CLI_VERSION = "0.0.24";
