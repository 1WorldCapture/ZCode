/**
 * raft-agents 模块公开契约：Raft Agent 绑定的接入、记录与生命周期意图管理。
 * 只允许从这里 import；CLI 子进程、文件存储等实现细节都在模块内部。
 *
 * T1 范围（task #2）：绑定记录 + 凭据适配 + 单表单接入。
 * bridge / 唤醒 / 工具注入 / 记忆由后续任务（T2–T5）在本模块内扩展，
 * 扩展时先更新 SPEC.md 再动 contract。
 */
import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type RaftAgentBinding,
  type RaftAgentBindingInput,
  type RaftAgentCliHealth,
  type RaftAgentEnvironmentHealth,
  type RaftAgentListItem,
  type RaftAgentLocalCredential,
  type RaftAgentManagementResult,
  type RaftAgentMemoryContent,
  type RaftAgentMemoryFile,
  type RaftAgentOpenSessionResult,
  type RaftAgentRemoveHomeOutcome,
  type RaftAgentSetupResult,
  type RaftAgentStorageHealth,
  type RaftAgentVerifyCredentialInput,
  type RaftAgentVerifyResult,
} from "@zcode/shared";

import { createServiceDescriptor } from "#src/descriptors.js";

export type {
  RaftAgentBinding,
  RaftAgentBindingInput,
  RaftAgentCliHealth,
  RaftAgentEnvironmentHealth,
  RaftAgentListItem,
  RaftAgentLocalCredential,
  RaftAgentManagementResult,
  RaftAgentMemoryContent,
  RaftAgentMemoryFile,
  RaftAgentOpenSessionResult,
  RaftAgentRemoveHomeOutcome,
  RaftAgentSetupResult,
  RaftAgentStorageHealth,
  RaftAgentVerifyCredentialInput,
  RaftAgentVerifyResult,
} from "@zcode/shared";

/**
 * Raft Agents 服务实例接口，由 host 进程持有并经 RPC 暴露给 renderer。
 *
 * 安全不变量：token 只经 createBinding 的输入直达官方 CLI 的 stdin，
 * 不进任何返回值、事件、日志或持久化结构。
 */
export interface IRaftAgentsService {
  /** 列表投影（绑定记录 + 运行状态派生）。 */
  list(): Promise<RaftAgentListItem[]>;
  /**
   * 宿主环境健康探测：存储态（list() 抛错时界面拿有形状的原因，corrupt 带
   * storePath/backupPath）+ CLI 态（PATH/env 解析 + 版本门禁，不碰凭据）一次返回。
   * Agent 中心与接入向导进入时各调一次即可完成前置检查；装好 CLI 后可重调刷新。
   */
  getEnvironmentHealth(): Promise<RaftAgentEnvironmentHealth>;
  /**
   * 单表单接入：CLI 检测 → 登录（stdin token）→ 身份核验 → 唯一性校验 → 持久化。
   * 各步幂等；失败保留已完成步骤，返回错误码供表单展示。全程不启动 bridge、
   * 不读收件箱、不发消息（spec §4）。
   */
  createBinding(input: RaftAgentBindingInput): Promise<RaftAgentSetupResult>;
  /**
   * 移除绑定记录；deleteHome 同时删除 Home 目录与本地 profile（不撤销 Raft 侧 token，D4）。
   * 返回 Home 处置四态（RaftAgentRemoveHomeOutcome）：deleted（整删/本就不存在）、
   * kept_memory_cleared（归属不成立只清记忆面、保留目录）、untouched（未请求/守卫拒绝，
   * 未动过）、failed（中途失败，可能已部分删除）——界面按态如实提示。
   */
  removeBinding(bindingId: string, opts: { deleteHome: boolean }): Promise<RaftAgentRemoveHomeOutcome>;
  /** 更新值守意图；Running 的实际效果（bridge/会话）在 T2/T3 接入。 */
  setDesiredState(bindingId: string, desired: "ReadyStopped" | "Running"): Promise<void>;
  /**
   * 二期 A1：重启动作——新会话（同 Home/记忆配置/MCP）+ 改绑 + 代次重置；
   * 原 Running 自动恢复值守。旧会话保留为历史，进行中 turn 按崩溃口径补查。
   */
  restartBinding(bindingId: string): Promise<RaftAgentManagementResult>;
  /**
   * 二期 A1：重置动作——先清 Home 记忆面（MEMORY.md/AGENTS.md/notes/ 整树）并按
   * 初始模板重建，再同 restart 换新会话。不动 Home 其他内容、不动凭据与绑定。
   */
  resetBinding(bindingId: string): Promise<RaftAgentManagementResult>;
  /**
   * 二期 A1：凭据预核验（只核验、不保存）——临时 profile 走 login+whoami 后即毁，
   * 无持久残留；返回服务端认定的身份。向导第 4 步确认摘要用。
   */
  verifyCredential(input: RaftAgentVerifyCredentialInput): Promise<RaftAgentVerifyResult>;
  /** 二期 A1：记忆面文件列表（只读，限定该绑定 Home 的记忆面）。 */
  listMemoryFiles(bindingId: string): Promise<{ ok: true; files: RaftAgentMemoryFile[] } | { ok: false; code: "NotFound" }>;
  /** 二期 A1：读记忆面单个文件（512KB 上限，超出截断；越出记忆面在执行边界拒绝）。 */
  readMemoryFile(bindingId: string, path: string): Promise<RaftAgentMemoryContent>;
  /** 二期 A1：本机已有凭据枚举（apiKey 永不出现；boundBindingId 标记已占用）。 */
  listLocalCredentials(): Promise<RaftAgentLocalCredential[]>;
  /**
   * 二期 A1：宿主侧恢复入口（B3）——确保主会话存在（懒建）→ resume（带
   * agentMemory/officialMcpServers，不退项目记忆）→ 返回会话坐标。
   */
  openAgentSession(bindingId: string): Promise<RaftAgentOpenSessionResult>;
  /** 绑定记录变更广播（列表投影可能随之变化）。 */
  onBindingsChanged: Event<RaftAgentBinding[]>;
}

export const IRaftAgentsService = createServiceDescriptor<IRaftAgentsService>(
  ServiceChannels.RaftAgents,
);

/** Provisioning 步骤注入点（定义在 provisioning.ts，此处再导出保持公开契约面不变）。 */
export type { RaftProvisioningStep } from "./provisioning.js";

// 组合根工厂不走 contract 导出（storage 模块先例）：contract 只含类型与描述符，
// 避免实现文件反向 import contract 形成 require 环（raftAgentsService → contract → compose → raftAgentsService）。
// 工厂从 services 包入口（node.ts）导出：createDefaultRaftAgentsService ← ./raft-agents/compose.js。
