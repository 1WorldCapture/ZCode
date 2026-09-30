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
   * mcpServers 为一次性启动期注入（协议约束：首发后不可补写）；
   * wire 形状 = ZCodeAgentMcpServer（env 为 {name,value}[]，stdio 分支无 type/cwd 字段）。
   */
  createAgentSession(params: {
    workspacePath: string;
    mcpServers: import("@zcode/shared").ZCodeAgentMcpServer[];
  }): Promise<{ ok: true; sessionId: string } | { ok: false; code: "failed"; detail?: string }>;
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
