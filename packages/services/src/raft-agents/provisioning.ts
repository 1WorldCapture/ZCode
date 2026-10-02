// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning 步骤注入点：接入管线（bindingCreate）在持久化前按序执行，
 * 全部幂等（二期 A1 懒建后默认只有 Home 初始化，主会话改为首启创建）。
 * 类型属于公开契约面——contract.ts 从这里再导出，宿主与 app 实现统一从
 * contract 引用，保持依赖单向 app → contract；单独成文件以控制 contract
 * 的契约规模（架构上限）。
 */
import type { RaftAgentBinding } from "@zcode/shared";

export interface RaftProvisioningStep {
  readonly name: string;
  execute(binding: RaftAgentBinding): Promise<void>;
}
