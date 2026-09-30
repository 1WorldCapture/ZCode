# 端到端验收清单（第一期，task #8 / task #10）

依据：`work/zcode-raft-phase1-spec.md` §13 十条验收场景 + §14 已知限制 + 评审遗留项。
集成分支：`feat/raft-agent-binding`（含 `feat/raft-agent-ui` 全部内容）。

## 0. 环境与角色

| 项 | 值 / 负责 |
| --- | --- |
| 验收机器 | lyondeMacBook-Pro（macOS arm64）——Dev-developer 运行所在机，即 lyonliang 的本机 |
| Electron | v41.0.3 arm64 已验证可执行（`node_modules/electron/dist`） |
| ZCode 版本 | 集成分支 production build（Dev-developer 准备） |
| Raft 服务 | 本地 dev 栈（raft-source f7682db，daemon v1.0.25，CLI carrier 0.0.24；T0 已跑通唤醒链路）——Dev-developer 起栈 |
| 测试 agent ×2 | lyonliang 在 Raft 界面创建（**token 只填表单，不进频道/日志**）；名字告知 PM 建测试频道 |
| 点界面 | lyonliang（或其指定人）；后台日志与问题定位 Dev-developer |

安全红线（全程有效）：token 不出现在日志 / argv / 模型上下文 / Agent Home / UI store / 频道；
唤醒与 drain 文本不含消息正文与凭据形态；不做生产服务测试。

## 1. 十条验收场景（spec §13）

每条记录：通过与否 / 证据（截图或日志行）。

- [ ] **S1 填表接入**：单表单填 origin/server/agent/token → 成功；grep 日志与 argv 无 token；Home 目录无凭据文件。
- [ ] **S2 错 token 拒绝**：填属于另一 agent 的 token → 登录拒绝（IdentityMismatch），已有绑定数据不变。
- [ ] **S3 保存不开始**：desiredState=ReadyStopped → 无 bridge 进程、无收件读取、无发言。
- [ ] **S4 开始→@→回复**：点开始（Starting→Running）→ Raft 里 @ 该 agent → 正确频道/线程回复，身份正确（profile/agentId 对应）。
- [ ] **S5 忙时排队**：会话处理中再 @ → 入队不打断，随后处理（commandId 幂等，无重复回复）。
- [ ] **S6 崩溃重启补查**：杀 bridge 或重启 ZCode → 重启后自动恢复值守，从收件日志补查已读未落盘消息，记忆仍在。
- [ ] **S7 双 agent 隔离**：两个 agent 同时值守 → 身份/记忆/主会话互不串（各自 Home、各自 profile）；同 Home 写入路径第二次被拒（PathConflict）。
- [ ] **S8 已知限制标注**：读取即送达窗口、发帖超时不重发——文档如实标注即可，无需构造故障。
- [ ] **S9 积压处理**：停止期积累消息 → 点开始后 D8 drain 全部处理，不丢。
- [ ] **S10 异常暂停可区分**：制造 MEMORY 读不到（改 Home 权限）→ 列表"异常暂停 + 原因"（memory_unavailable），与手动暂停（ReadyStopped）显示可区分；修复后点开始可恢复。

## 2. 评审 / 任务遗留验证项（task #8）

- [ ] **主窗口判定**（ownerGuard）：双窗口/多 ServiceCollection 场景，bridge 只由一处启动（当前缺省恒真 + 进程锁，验证锁行为并决定是否接真实判定）。
- [ ] **打包态路径**：production build 里 CLI（raft ≥0.0.24 / `ZCODE_RAFT_CLI`）与官方插件（raft-agent-tools）解析路径正确；MCP 引用 fail-closed 语义在打包态成立。
- [ ] **真实 resume 失败形态**：会话记录丢失时的实际错误 → SessionResumeFailed + ErrorPaused(session_unavailable) 投影；是否自动重建留二期决策。
- [ ] **工具名前缀**：唤醒/drain 文本里的 `raft_message_check` 模型能否对上完整工具名（`mcp__raft_agent_tools__raft_message_check`）；对不上则把前缀写进文本。
- [ ] **activity drain**：bridge 侧不再出现 drain 404 噪音（e04a5ee 修复的实测确认）。

## 3. UI 点验清单（SPEC.md T6 小节）

- [ ] 接入表单 12 个错误码各有中文文案（CliMissing/AgentIdInvalid/IdentityMismatch/PathConflict/…）。
- [ ] 列表两种暂停显示：用户暂停（ReadyStopped）与异常暂停（含 7 种 reason 文案）可区分。
- [ ] 异常暂停状态下"开始"按钮可用（修复后可重试）。
- [ ] 详情页"打开 Home 文件夹"正确打开对应目录。
- [ ] 中英文案切换正常。

## 4. 记录

验收结果逐条记在本文件底部追加的"验收记录"节（日期 / 执行人 / 结果 / 证据）。
