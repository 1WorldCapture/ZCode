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

| code                                                    | 触发                      | 已完成步骤保留             |
| ------------------------------------------------------- | ------------------------- | -------------------------- |
| CliMissing / CliVersionUnsupported                      | 未找到 raft 或 <0.0.24    | 无                         |
| OriginInvalid                                           | 地址不可规范化            | 无                         |
| TokenInvalid / IdentityMismatch / CredentialCheckFailed | 登录被拒（CLI Code 分类） | profile 可能残留，重试幂等 |
| PathConflict / SlugConflict                             | 唯一性校验                | 无                         |
| StoreWriteFailed                                        | 持久化失败                | 内存态回滚                 |

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

## T4：Raft 工具适配器与收件日志（task #5）

上游依据：第一期 spec §6、§7；T0 实测约束（环境净化、CLI ≥0.0.24）。

### 行为

把白名单 Raft 操作封装成会话内可调用的工具，内部执行官方 raft CLI；`message check` 的输出先写入收件日志再返回模型。代码在独立宿主型插件包 `apps/zcode-cli/packages/raft-agent-tools`（不在本模块内，不依赖 `@zcode/services`；生产态只有 `apps/zcode-cli/packages` 下的包会被 stage 进发行包）：核心 `toolCall.ts` / `cliToolAdapter.ts` / `inboxLogStore.ts` / `cliRunner.ts`，MCP 服务 `server.ts`，stdio 入口 `entry.ts`，构建产物 `dist/mcp/server.js`。

### 不变量

1. **身份固定，构造而非过滤**：argv 前缀固定为 `--profile <slug>`，业务参数只来自结构化字段；取值统一 `--flag=value`，以 `-` 开头的值过不了格式校验，无法变成另一个选项。子进程环境净化后只设 `RAFT_PROFILE_DIR`，不继承宿主/调用方的 `RAFT_*`、`SLOCK_*`。
2. **白名单**：`message check|read|send`、`task list|claim|update`。不放行 `--anyway`、`--target-confirmed`、登录/绑定类命令。
3. **task update 只放行 `in_progress` / `in_review`**，拒绝 `done`/`closed`/`todo`（完成由人验收后置 done）。
4. **`message check` 先落盘再返回**：服务端在返回前已标记送达，消息丢失无法重放。写日志失败有限重试（默认 3 次）；仍失败则**仍把结果返回模型**，同时上报（服务置 ErrorPaused(inbox_log_write_failed)）。空收件箱不写空日志。
5. **发帖被「新鲜度门」扣成草稿（`SEND_HELD_AS_DRAFT`）**：把 CLI 返回（含回放的新消息）原样交还模型，由模型决定发原稿（`sendDraft:true`）、改稿重发或放弃；适配器不自动重试、不自动 `--send-draft`。
6. **发帖结果不确定**（超时被杀、`UNKNOWN`/`CANNOT_CONFIRM`）：返回 unknown，不自动重发。
7. **日志与隐私**：应用日志只记 messageId 与条数，不记正文；正文只在收件日志文件里。

### 收件日志存储

- 位置 `<ZCodeDataRoot>/raft/inbox-logs/<bindingId>/`，不在 Agent Home。目录 0700、文件 0600；一条日志一个文件（`<13位毫秒时间戳>-<8位随机>.json`），追加不重写既有内容。
- 默认保留 14 天，上限 30 天（配置超过上限按上限）；清理依据文件名时间戳。
- 恢复用途：崩溃/重启后按日志补查（配合 `message read --around`），不承诺 exactly-once。
- 解绑保留日志；用户显式删除绑定时一并删除。
- **单写者**：日志只由 stdio 工具服务进程写入，host 只读（列表/补查/清理入口经服务进程或在服务进程未运行时由 host 独占）。

### 传输方式：stdio MCP 服务（方案 B）

- `createSession.mcpServers` 注入 stdio 服务；会话记录里只有 command/args/env，env 只放路径（`RAFT_PROFILE_DIR`、bindingId、数据根），**不含任何 token**（Raft 凭据留在 profile 目录，由 CLI 自己读取）。
- 拒绝 `type:http` + 请求头方案：头会随会话记录持久化，违反凭据不落记录红线，且 host 端点跨会话共享会削弱 session 隔离。
- 打包态 `process.execPath` 是 ZCode Helper，必须带 `ELECTRON_RUN_AS_NODE:"1"` 与 host 前缀参数（`createBundledMcpRuntimeConfig` 已处理）。

### 工具入参（结构化）

| 工具          | 入参                                                         |
| ------------- | ------------------------------------------------------------ |
| message_check | 无                                                           |
| message_read  | target；可选 after/before/around/limit(1–200)                |
| message_send  | target；content（正文，经 stdin）或 sendDraft:true，二者互斥 |
| task_list     | target(频道) 和/或 mine；可选 status                         |
| task_claim    | target(频道)；numbers(1–20 个正整数)                         |
| task_update   | target(频道)；number；status ∈ {in_progress,in_review}       |

### 验收（T4 部分）

1. 无法通过任何入参改变 profile/server/身份（含 `--profile=evil` 形态值被拒）。
2. `task_update` 置 done 被拒。
3. `message_check` 后日志含完整正文；应用日志不含正文；空收件箱不产生日志。
4. 日志写失败：重试 3 次后消息仍返回模型，且失败被上报。
5. 发帖被扣草稿：返回内容含回放的新消息，适配器未自动重试。
6. 保留期清理与非法 bindingId 拒绝。
   （1–6 已有单测覆盖，见 `packages/services/test/raftAgentsTools.test.ts`。）

### T3 注入约定（raft-agents 服务侧）

- 官方插件 id：`raft-agent-tools@zcode-plugins-official`（`OFFICIAL_RAFT_AGENT_TOOLS_PLUGIN_ID`，已在 seed 定义中登记，默认启用、无 listing）。用它解析 `rootPath`，再用 `createBundledMcpRuntimeConfig({ rootPath, cwd, env })` 生成 stdio 配置。
- `mcpServers` 条目必须设 `isolation: "session"`（**不是** node-repl 那样的 `"workspace"`，否则跨会话共享连接会串身份）和 `protocolVersion: "2026-07-28"`（服务只支持该版本，`legacy` 会被拒绝）。
- 启动环境（只放路径与标识，不含 token）：`ZCODE_RAFT_BINDING_ID`、`ZCODE_RAFT_PROFILE_SLUG`、`ZCODE_RAFT_PROFILE_DIR`（单个 profile 目录）、`ZCODE_RAFT_DATA_ROOT`、`ZCODE_RAFT_CLI_PATH`（T1 已校验的 CLI 入口）；可选 `ZCODE_RAFT_INBOX_RETENTION_DAYS`。
- 日志写失败的感知：服务进程向 stderr 输出一行 `RAFT_INBOX_LOG_WRITE_FAILED {"bindingId":...,"reason":...}`，宿主据此置 `ErrorPaused(inbox_log_write_failed)`。
- 工具名（模型可见）：`raft_message_check|read|send`、`raft_task_list|claim|update`，入参见上表，均不含身份字段。
