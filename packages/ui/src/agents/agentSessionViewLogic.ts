// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

/**
 * 嵌入会话视图的重开判定（二期验收修复，PM 口径：收到绑定变化、主会话编号
 * 变了就重新打开会话视图）。
 *
 * 输入取 list 投影的 mainSessionId 与视图当前已打开的 sessionId：
 * - 投影编号变化（重启/重置/懒建兜底等换会话路径，服务层 sessionSwap 落盘成功
 *   后广播）→ 重开，视图跟随新会话；
 * - 投影编号与已打开一致 → 跳过。覆盖冷态懒建回填：openAgentSession 懒建后
 *   投影才写入同一编号，此时不重开（重开会闪一次加载态，会话还是同一个）；
 * - 投影为 null（懒建未发生或尚不可知）→ 打开/重开。挂载首开即此形态；
 *   已打开后投影退回 null 视为信号丢失，重开由 openAgentSession 幂等兜底。
 */

export function shouldReopenSession(
  mainSessionId: string | null,
  openedSessionId: string | null,
): boolean {
  if (mainSessionId === null) {
    return true;
  }
  return mainSessionId !== openedSessionId;
}
