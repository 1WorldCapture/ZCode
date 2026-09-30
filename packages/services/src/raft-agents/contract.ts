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
  type RaftAgentListItem,
  type RaftAgentSetupResult,
} from "@zcode/shared";

import { createServiceDescriptor } from "#src/descriptors.js";

export type {
  RaftAgentBinding,
  RaftAgentBindingInput,
  RaftAgentListItem,
  RaftAgentSetupResult,
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
  get(bindingId: string): Promise<RaftAgentBinding | null>;
  /**
   * 单表单接入：CLI 检测 → 登录（stdin token）→ 身份核验 → 唯一性校验 → 持久化。
   * 各步幂等；失败保留已完成步骤，返回错误码供表单展示。全程不启动 bridge、
   * 不读收件箱、不发消息（spec §4）。
   */
  createBinding(input: RaftAgentBindingInput): Promise<RaftAgentSetupResult>;
  /** 移除绑定记录；deleteHome 同时删除 Home 目录与本地 profile（不撤销 Raft 侧 token，D4）。 */
  removeBinding(bindingId: string, opts: { deleteHome: boolean }): Promise<void>;
  /** 更新值守意图；Running 的实际效果（bridge/会话）在 T2/T3 接入。 */
  setDesiredState(bindingId: string, desired: "ReadyStopped" | "Running"): Promise<void>;
  /** 绑定记录变更广播（列表投影可能随之变化）。 */
  onBindingsChanged: Event<RaftAgentBinding[]>;
}

export const IRaftAgentsService = createServiceDescriptor<IRaftAgentsService>(
  ServiceChannels.RaftAgents,
);

/**
 * Provisioning 步骤注入点：T5（Home 初始化）/T3（主会话）按序接入，全部幂等。
 * 类型属于公开契约，定义在 contract（app 实现只引用不定义），保持依赖单向 app → contract。
 */
export interface RaftProvisioningStep {
  readonly name: string;
  execute(binding: RaftAgentBinding): Promise<void>;
}

// 组合根工厂不走 contract 导出（storage 模块先例）：contract 只含类型与描述符，
// 避免实现文件反向 import contract 形成 require 环（raftAgentsService → contract → compose → raftAgentsService）。
// 工厂从 services 包入口（node.ts）导出：createDefaultRaftAgentsService ← ./raft-agents/compose.js。
