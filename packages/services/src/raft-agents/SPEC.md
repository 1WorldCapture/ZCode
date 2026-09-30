# Raft Agents 模块规格（T1：Binding 记录 + 凭据适配 + 单表单接入）

状态：T1 实现中（task #2）；T2–T5 将扩展本模块（bridge、唤醒、工具、记忆）。
上游依据：`#zcode-raft-integration` 频道第一期 spec v1（已评审通过）§1–§4、§12。

## 行为

管理「Raft Agent 绑定」：一条绑定 = 一个 Raft Agent 身份在 ZCode 中的接入记录。T1 范围 = 绑定记录的持久化与生命周期数据、官方 raft CLI 凭据适配（版本检测 + token 登录 + 身份核验）、单表单接入入口；不含 bridge、唤醒、工具注入、记忆（后续任务在本模块内扩展）。

## 状态所有者与边界

- **唯一所有者**：main 进程的 `RaftAgentsService` 实例。绑定记录的读写、登录子进程的拉起、profile 目录的创建都只经它；renderer 经 IPC 桥调用 contract，不持有第二份可写状态。
- 数据类型唯一事实源：`@zcode/shared/raft-agents`（renderer 桥与 main 共用）；本模块 `contract.ts` 再导出。
- 持久化：`<ZCodeDataRoot>/raft/bindings.json`（应用管理数据；原子写 tmp+rename）；profile 目录 `<ZCodeDataRoot>/raft/profiles/<slug>/`。不放 Agent Home、不进 UI 持久 store。

## 不变量

1. `bindingId` 创建后不变；`adapterInstance === bindingId`。
2. `homeWorkspacePath` 全局唯一：与任一既有绑定经 `path.resolve` 规范化后不得相等、不得互为前缀（防父目录绕过）。
3. `profileSlug` 唯一；`(raftOrigin, serverId, raftAgentId)` 组合唯一。
4. 身份三证一致才允许保存：login 成功（CLI 内部校验 token↔agentId）+ whoami 复核 `agentId === 期望` 且 `serverUrl` 与 `raftOrigin` 规范化后一致；`serverId` 取自 whoami。
5. token 只经 stdin 传给官方 CLI；不进 argv、日志、模型上下文、Agent Home、UI 持久 store、绑定存储。绑定存储永不包含 token 本体。
6. 所有 raft 子进程在净化环境运行（仅 HOME/PATH/RAFT_PROFILE_DIR[+后续 bridge 的 RAFT_CHANNEL_TOKEN]）——CLI 在托管环境下检测到注入变量会拒绝 `--profile`（PROFILE_MANAGED_CONTEXT_CONFLICT）。
7. T1 完成态只到 `ReadyStopped`：不启动 bridge、不读收件箱、不发任何消息。
8. 接入流程各步幂等：重复重试不重复创建 profile/记录。

## 接口（contract.ts）

```ts
interface IRaftAgentsService {
  list(): Promise<RaftAgentListItem[]>;
  get(bindingId): Promise<RaftAgentBinding | null>;
  createBinding(input: RaftAgentBindingInput): Promise<RaftAgentSetupResult>;  // 后台顺序执行，失败保留已完成步骤
  removeBinding(bindingId, opts: { deleteHome: boolean }): Promise<void>;      // T1 不撤销 Raft 侧 token（D4）
  setDesiredState(bindingId, "ReadyStopped" | "Running"): Promise<void>;       // Running 的实际效果在 T2/T3 接入
}
```

事件：`onBindingsChanged`（列表投影变更广播）。

## 失败语义（setup 错误码 → 用户文案）

| code | 触发 | 已完成步骤保留 |
|---|---|---|
| CliMissing / CliVersionUnsupported | 未找到 raft 或 <0.0.24 | 无 |
| OriginInvalid | 地址不可规范化 | 无 |
| TokenInvalid / IdentityMismatch / CredentialCheckFailed | 登录被拒（CLI Code 分类） | profile 可能残留，重试幂等 |
| PathConflict / SlugConflict | 唯一性校验 | 无 |
| StoreWriteFailed | 持久化失败 | 内存态回滚 |

重试 = 重新提交表单；每步幂等，不产生重复副作用。

## CLI 子进程契约（已对 raft-source f7682db / CLI 0.0.24 核实）

- 版本：`raft --version` → `Raft CLI: <semver>`；最低 0.0.24；入口须为 `dist/index.js`（`dist/raft.js` 为陈旧入口，缺 RAFT_PROFILE_DIR 支持）。
- 登录：`raft agent login --server <origin> --agent <id> --profile-slug <slug> --profile-dir <dir>`，token 经 stdin 单行；CLI 自带 token 验证与 agentId 一致性校验（AGENT_IDENTITY_MISMATCH）。
- 核验：`raft auth whoami` → JSON `{ok,data:{agentId,serverUrl,serverId,...}}`（token 恒不回显）。
- 错误形态：非零退出 + stderr `Code: <CODE>` 行。

## 验收（T1 部分）

1. 填表接入全程无手动 CLI；token 不出现在日志/argv/上下文/存储。
2. token 属于错误 Agent → 登录拒绝，无持久化残留（场景 2）。
3. 保存后 desiredState=ReadyStopped，无任何网络发言行为（场景 3 前半）。
4. 单测覆盖：origin 规范化、路径前缀唯一性（含父目录绕过用例）、slug/组合唯一、stderr Code 分类、绑定存储原子写、setup 幂等。
