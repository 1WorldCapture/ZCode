# raft-agents 模块契约

Raft Agent 绑定管理（第一期 T1：Binding 记录 + 凭据适配 + 单表单接入）。

- 公共入口：`contract.ts`（`IRaftAgentsService` + 描述符；类型事实源在 `@zcode/shared/raft-agents`）。
- 行为规格与不变量：见本目录 `SPEC.md`（实现前先更新它）。
- 分层：`domain/` 纯校验；`app/` 编排 + 端口；`adapters/` 官方 raft CLI 子进程与文件存储。
- 状态所有者：host 进程内的服务实例；renderer 经 RPC 调用 contract，不持有可写副本。
- 安全：token 只经 stdin 传给官方 CLI；不进 argv/日志/事件/持久化。子进程环境白名单构造（见 `adapters/raftCli.ts` 头注）。
- 后续任务（T2 bridge、T3 唤醒/会话、T4 工具、T5 记忆）在本模块内扩展，先改 SPEC.md 与 contract。
