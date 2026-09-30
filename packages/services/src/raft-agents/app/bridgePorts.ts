/**
 * T2 Bridge 管理的 app 层端口。与 ports.ts（T1）分开，避免两个任务改同一个文件。
 */

/** 唤醒端点（T3 提供）：bridge 唤醒时 POST 到这里；token 由端点所有者按绑定生成与保管。 */
export interface WakeEndpointPort {
  /** 确保该绑定的端点已监听并返回地址与 token；幂等。 */
  open(bindingId: string): Promise<{ url: string; token: string }>;
  close(bindingId: string): Promise<void>;
}

/** 只有主窗口承载 bridge；判定由 Host 装配层提供（spec §9）。 */
export interface OwnerGuardPort {
  isOwner(): boolean;
}

/** 启动 bridge 所需的绑定最小信息（避免 supervisor 依赖整个绑定结构）。 */
export interface BridgeBindingRef {
  bindingId: string;
  profileSlug: string;
  raftAgentId: string;
}

export type BridgeStartResult =
  | { ok: true; pid: number }
  | {
      ok: false;
      code:
        | "NotOwner"
        | "AlreadyRunning"
        | "LockHeld"
        | "EndpointUnavailable"
        | "SpawnFailed"
        | "EarlyExit";
      /** 早退时的退出码与 stderr 尾部（已去掉 token 形态内容）。 */
      detail?: string;
    };

/** bridge 进程退出通知。requested=true 表示由 stop/stopAll 主动结束，不应被当作故障。 */
export interface BridgeExitInfo {
  bindingId: string;
  requested: boolean;
  code: number | null;
  signal: string | null;
  /** stderr 尾部，已脱敏（不含 token）。 */
  stderrTail: string;
}

export interface BridgeSupervisorPort {
  start(binding: BridgeBindingRef, cliPath: string): Promise<BridgeStartResult>;
  /** 主动停止：SIGTERM，超过宽限强杀；不存在则视为成功。 */
  stop(bindingId: string): Promise<void>;
  /** 有序停止全部（挂进 Host 关停流程）。 */
  stopAll(): Promise<void>;
  /** 同步强杀全部（Host 的同步收口路径，无法 await 时使用）；清理仍由退出事件异步完成。 */
  terminateAllNow(): void;
  isRunning(bindingId: string): boolean;
  /** 订阅退出通知（意外退出 → 服务置 ErrorPaused(bridge_exit)）。 */
  onExit(listener: (info: BridgeExitInfo) => void): () => void;
}
