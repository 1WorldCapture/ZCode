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
  | { ok: false; code: "TokenInvalid" | "IdentityMismatch" | "CredentialCheckFailed"; detail?: string };

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
  whoami(params: { profileSlug: string; profileDir: string }): Promise<RaftCliWhoami | { error: string }>;
  /**
   * 删除本地 profile 目录（登录成功后的失败路径防孤儿凭据）。
   * profilesRoot 用于包含性防护：profileDir 不在其内则拒绝删除。
   * 容错：目录不存在视为成功；失败向上抛由调用方决定是否吞掉。
   */
  destroyProfile(params: { profileDir: string; profilesRoot: string }): Promise<void>;
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
