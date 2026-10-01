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
  removeBinding(bindingId, opts: { deleteHome: boolean }): Promise<RaftAgentRemoveHomeOutcome>;  // T1 不撤销 Raft 侧 token（D4）；A1 起返回 Home 处置四态（见删除守卫）
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
| HomeOverlapsCredentials                                 | Home 包住/落入 raft/profiles（明文凭据；登录前拒绝） | 无             |
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
6. **发帖结果不确定**（超时被杀、`UNKNOWN`/`CANNOT_CONFIRM`）：返回 unknown，不自动重发。2026-09-30 实测注记：官方 CLI 以 `process.exitCode` 结束、残留句柄会把已成功的发送拖到超时，误报 unknown——已由「权威成功行即收口」（`settleWhenStdoutMatches`）消除该误报形态；unknown 语义保留给真正的网络失败，实测中被测 agent 正确执行「读频道核对、确认送达即不重发」。
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

## T2：Bridge 管理（task #3）

上游依据：第一期 spec §8.1、§9；T3 已锁定的 `WakeEndpointPort` 约定。

### 行为

每个绑定一个官方 `raft agent bridge` 子进程（`adapters/bridgeSupervisor.ts`），启动参数：`--profile <slug> agent bridge --expected-agent=<agentId> --adapter-instance=<bindingId> --wake-adapter=wake-channel --wake-channel-endpoint=<url> --json`。`RAFT_CHANNEL_TOKEN` 只经子进程环境传入（token 由唤醒端点所有者生成并保管，只存内存）；环境净化，不继承 `RAFT_*`/`SLOCK_*`。

### 不变量

1. 同一绑定同一时刻最多一个 bridge：进程内映射 + pid 锁文件 `<ZCodeDataRoot>/raft/locks/<bindingId>.lock`（持有者是拉起 bridge 的宿主进程；持有者已不存在视为陈旧锁并清除；只删自己写的锁）。
2. 只有主窗口承载：启动前必须通过 `OwnerGuardPort.isOwner()`，否则返回 `NotOwner`，且**不得打开唤醒端点**。
3. 顺序：先 `wakeEndpoint.open()` 再拉起进程（端点必须先存在）；进程**确认退出后**才释放锁、`close()` 端点、通知（stop 与崩溃路径一致）。`stop()` 等待的是这些清理完成之后。
4. 拉起后 settle 窗口（默认 1.5s）内退出视为启动失败，返回 `EarlyExit` 与已脱敏的 stderr 尾部（覆盖参数错误、身份不符等立即失败）；该情况不再走 `onExit` 通知。
5. 意外退出**不自动重启**：通知 `BridgeExitInfo{requested:false, code, signal, stderrTail}`，由服务置 `ErrorPaused(bridge_exit)`；用户点开始才重新拉起。主动 stop 的退出 `requested:true`，不算故障。
6. stderr 尾部（4KB）与错误信息里抹掉本次 token 与任何 `sk_agent_` 形态内容；token 不进 argv、日志、通知。

### 关停

- `stopAll()`：SIGTERM，超过宽限（默认 2s，**必须小于** Host `service-dispose` 阶段超时 3.5s）后 SIGKILL；挂进 Host 关停的 `service-dispose` 阶段。
- `terminateAllNow()`：同步强杀，用于 `disposeHostResourcesBestEffort` 这类无法 await 的同步收口路径。
- 已知限制：宿主进程被强杀（崩溃）时 bridge 子进程可能成为孤儿；它的唤醒会打到已关闭的端点被拒，重启后重新 open 换新 token，旧 bridge 因 token 失效无法注入。孤儿进程的主动回收（按 pid 记录清理）留给后续。

### 接口

`BridgeSupervisorPort`：`start(binding, cliPath)`、`stop`、`stopAll`、`terminateAllNow`、`isRunning`、`onExit`。启动结果码：`NotOwner|AlreadyRunning|LockHeld|EndpointUnavailable|SpawnFailed|EarlyExit`。`WakeEndpointPort`（`open/close`）由 T3 提供，类型定义在 `app/bridgePorts.ts`。服务侧编排（会话恢复与 MEMORY 校验之后才启动 bridge、退出后置 ErrorPaused）在 T3/T5 接入时装配，本任务不改 T1 的服务文件。

### 验收（T2 部分）

单测（`packages/services/test/raftAgentsBridge.test.ts`，9 项）覆盖：固定身份 argv 与 token 只在环境变量里、主动 stop 不算故障、启动早退与脱敏、意外退出上报、非主窗口拒绝且不打开端点、重复启动、pid 锁（存活持有者/陈旧锁/只删自己的锁）、忽略 SIGTERM 时强杀、同步强杀。

## T5：Agent Home 与记忆（task #6）

上游依据：第一期 spec §3、§5、§6；T5a 内容包（已验收）。

### 行为

一个绑定对应一个 Agent Home（默认 `<ZCodeDataRoot>/agents/<bindingId>/workspace/`）：`MEMORY.md`（Role / Key Knowledge / Active Context）、`AGENTS.md`、`notes/`。Agent 会话的**记忆根就是 Home**，取代项目记忆；记忆规则用独立的 raft-agent section，不复用项目记忆模板。

### 不变量

1. **初始化只写缺失、永不覆盖**（独占创建）；模板里的名称/描述来自 Raft 公开档案（不可信），渲染前压成单行、去控制字符、截断，`{{...}}` 不二次展开。目录 0700、文件 0600。
2. **值守开始前的同步闸门 `verifyMemoryAvailable`**：只读，不创建任何东西；失败码 `HomeMissing|MemoryMissing|MemoryUnreadable|MemoryEmpty`，编排器统一置 `ErrorPaused(memory_unavailable)` 并在 UI 展示具体原因。`MEMORY.md` 必须是 Home 根下的普通文件（符号链接/目录一律拒绝，防止把任意文件读进模型上下文）——**符号链接由这个闸门用 lstat 拦截**，core 侧的 `FileSystemPort.stat` 会跟随链接，只兜住缺失/目录/不可读。
3. **会话上下文加载（core，第二层防线）严格失败**：Home 或 MEMORY.md 缺失、非普通文件、不可读、为空都抛 `AgentMemoryUnavailableError`（`home_missing|memory_missing|memory_unreadable|memory_empty`），**不走项目记忆的宽松 catch**；agent 会话绝不自动创建 Home 目录。过长按现有预算（200 行 / 25000 字符）截断并明示 `WARNING: … Only part of it was loaded`，不静默当作完整读取。
4. **项目记忆自动抽取对 agent 会话关闭**（另一套记录规则、另一个目录）；Agent 按 raft-agent 规则显式维护 MEMORY/notes。
5. Agent 记忆不受 Settings 的项目记忆开关影响（它是身份恢复入口，不能被静默关掉）。
6. 记忆不是权威：身份、权限、凭据只来自绑定/宿主/服务端，MEMORY 里的 Role 不能扩权（写进 AGENTS.md 与记忆 section）。

### 会话侧协议（宿主在 create 与 resume 边界都必须下发，CLI 不持久化，与 `mcpServers` 同语义）

`session/create` 与 `session/resume` 的参数新增两个可选字段（shared：`zcodeAgentMemorySchema`、`zcodeOfficialMcpServerRefSchema`）：

- `agentMemory: { homeRoot: string, agentName?: string }`：缺省 = 普通项目记忆会话。**resume 不带会让冷恢复的 Agent 会话退回项目记忆**，所以宿主每次恢复都要再次下发。
- `officialMcpServers: [{ name: "raft-agent-tools", env: [{name, value}] }]`：官方宿主型 MCP 服务的具名引用。command/args/`isolation:"session"`/`protocolVersion:"2026-07-28"` 由 app-server 用自己的插件 rootPath 拼装并锁定（打包态的 `process.execPath` 与插件宿主前缀参数只在 app-server 进程里有意义，host 侧自己拼会在打包态断裂）。`name` 白名单，未知名字拒绝；`env` 键必须以 `ZCODE_RAFT_` 开头，其余（如 `NODE_OPTIONS`）拒绝；插件缺失或未启用时 fail-closed 抛错，不静默降级为无工具会话。MCP 会话内 server 名为 `raft_agent_tools`。

### 主会话重建（resume 失败时，2026-09-30 PM 批准提前进第一期）

内嵌 agent 运行时的会话事件存储为内存态：ZCode 进程退出（重启/崩溃）后，`mainSessionRef` 指向的主会话不复存在（实测 `Session not found`）。值守开始链在 resume 失败时**自动重建**主会话：

> **2026-10-01 实测更正（二期调查）**：上段"事件存储为内存态"的归因不准确。app-server 启动时无条件打开 sqlite 落盘库（`openStartupSessionStore` → `~/.zcode/cli/db/db.sqlite`，session/message/part/session_input/tool_usage 等表），对所有会话（含 agent 主会话）一视同仁；进程内 event store（`create-app.ts` 缺省 `createInMemorySessionEventStore`）只是 live 视图与 seq 来源，不是持久层。"重启后 `Session not found`"的真实成因是**空壳预建会话从未越过统一持久化边界**——保存绑定时预建、零输入 → 零 session 行（resume 的 `getPersistedSession` 查无行即报此错），叠加修复前的 admission FK 缺陷（10ceaac）。处理过消息的会话均正常落库并跨重启 resume（TestAgent-1 主会话 199 message / 93 tool_usage，多次重启同一 sessionId、代次递增）。自动重建因此只可能在"从未处理过输入"的会话上触发，语义无损（本就没有上下文可丢）。

- 重建走 `createAgentSession`（与接入时同一入口），`agentMemory`/`officialMcpServers` 同语义重发；锁内把 `mainSessionRef` 改绑为新会话、代次重置为 1（旧 fencing 随旧 sessionId 失效），仅在引用仍指向被替换旧会话时写入（防并发双写）。
- **语义（界面与文档如实说明）：重建后主会话内的对话上下文丢弃，不保留；Home 里的长期记忆（MEMORY.md/notes）不受影响。** Home 记忆是持久层，主会话是可重建的运行时资源。
- 重建失败（create 也失败）才置 ErrorPaused(session_unavailable) 并不启动 bridge。
- 日志：重建前后各一条（含原因与新旧 sessionId）。

### 主会话权限模型（无人值守，e2e S4 第五层定稿）

主会话由频道消息驱动、无人审批，权限模型与交互会话不同，三层缺一不可：

1. **`mode: "yolo"`（全自动）**：V4 缺省权限模式对 MCP 工具调用要求人工批准，值守场景没人批准 → 工具调用永久悬挂（`pendingPermissions` 挂起，run4 根因）。yolo 在权限服务里排在项目规则之前放行，是值守会话唯一可用的模式。create 时锁定；每次 `sendText` 投递也显式带 `mode:"yolo"`——mode 会固化进队列输入的 canonical intent，堵住「空草稿会话重启后 resume 派生不出 mode、退回默认 ask 模式」的角落。resume 不传 mode（协议侧从持久化消息派生）。
2. **`toolAllowlist`（注册级白名单）**：`session/create`/`session/resume` 原生参数，内置与 MCP 工具都按注册面过滤。= Raft 六工具（`mcp__raft_agent_tools__*`，server 名由 app-server 锁定）+ `Read`/`Write`/`Edit`/`Glob`/`Grep`/`TodoWrite`（维护 Home 记忆所需最小集）。**刻意不含 Bash**（唯一任意副作用入口）；**不含 ApplyPatch**（其路径藏在 `patch_text` 里，第 3 层无法低成本校验）。resume 必须重发（否则冷恢复后工具面变宽）。工具集与 `apps/zcode-cli` 的 `official-mcp-hosts.ts` 锁定的 serverKey 两处同步。
3. **`confineFileToolsToWorkspace`（文件工具边界，新增 wire 参数）**：yolo 与白名单都约束不了「已注册文件工具指向哪里」——现状文件工具对 workspaceRoot 外路径不设防（path-policy 故意放行子代理跨仓需求），yolo 下等于全盘可读写。开启后 `Read`/`Write`/`Edit`/`Glob`/`Grep` 的路径入参（`file_path`/`path`/`cwd`）越出 workspaceRoot（= Agent Home）在**执行边界**拒绝（deny 可恢复，模型可改用根内路径），排在 yolo 放行与 memory 放行之后、不可被 hook/审批改写。**读也一并限**：全盘可读 + `raft_message_send` 即数据外带通道。create 与 resume 同语义重发。

安全性质：频道里的任意消息最多驱动 Agent 读写自己的 Home 与发 Raft 消息。路径判定在 realpath 两侧进行（根与目标都规范化后判包含）：Home 内预置的指向外部的符号链接被解析后拒绝，根本身经符号链接给出（macOS `/var` → `/private/var` 一类）不产生误判。glob 模式键（Glob.pattern / Grep.glob）含 `..` 段或绝对路径前缀直接拒绝（Grep.pattern 是内容正则，不在此列）。配套：T1 创建绑定拒绝「Home 包住或落入 `raft/profiles`（明文凭据）」的路径（`HomeOverlapsCredentials`），否则该限制形同虚设。

已知边界（评审确认，非阻塞，2026-09-30）：① `isAbsolute(pattern)` 在 macOS/Linux 上识别不了 Windows 盘符写法（`C:/...`）——值守只跑在宿主平台，mac 无影响，将来支持 Windows 时补盘符判断；② Home 内指向外部目录的符号链接可能让 Glob `**` 遍历在结果里列出外部文件的名字——只泄露名字，读取时仍被 realpath 判定拦截，二期收紧。

### 已知限制

- Agent Home 会话必须经 Agent 列表进入（宿主才会带上 `agentMemory` 与 `officialMcpServers`）。若绕过它、把 Home 目录当普通项目直接打开会话，会退回项目记忆且没有 Raft 工具，第一期靠「Home 会话只从 Agent 列表进入、不注册普通 tab」（D7）规避，不做目录猜测。
- 不做记忆修订历史与并发编辑冲突检测（二期，只读查看也在二期）。

### 验收（T5 部分）

单测：Home 初始化（不覆盖、权限、模板注入防护）、`verifyMemoryAvailable` 各失败码且不创建 Home、符号链接/目录拒绝（services，5 项）；core：记忆根解析、agent section、请求上下文标签、严格加载各失败码、抽取跳过（6 项）；bootstrap：具名解析锁定隔离与协议版本、env 前缀白名单、fail-closed（3 项）；shared：schema 白名单与 create/resume 均携带（3 项）。

## T6：最小 UI（task #7）

上游依据：第一期 spec §10、范围文档 UI 条目；**范围调整（2026-09-30，已拍板）：第一期不嵌入会话视图**，spec §10 中"详情页复用现有会话视图"一条降到二期。

### 第一期范围

- 侧边栏**顶部导航区**的一级入口 Agents（与「新建任务/搜索/自动化/插件市场」同样的图标加文字样式，激活时高亮；不再有底部小图标）；空状态显示"接入 Agent"引导；数据来自服务的 `list()`（绑定记录 + 运行态覆盖层），不从标签页推导。
- 列表行：名称、Raft 服务、连接状态、运行状态、开始/暂停。**用户暂停与异常暂停可区分，异常暂停带原因**（`memory_unavailable|credential_invalid|bridge_exit|inbox_log_write_failed|cli_unavailable`）；两种暂停都允许再次点「开始」。
- 详情页：身份、连接状态、运行状态（含原因）、Home 路径与"打开 Home 文件夹"；会话区只放说明，Agent 的对话在 Raft 里看。
- 单表单接入页：服务地址、Agent ID、token（密码框）、Home 路径；提交调用 `createBinding`，12 个错误码各配中英文文案；token 提交后立即清空，永不进 store。
- 数据同步：挂载加载 + `onBindingsChanged` 事件 + 3 秒轮询兜底运行态变化；卸载即停，不影响 host 值守（UI 生命周期与 Host 生命周期分离）。

### 降到二期的原因

现有会话视图长在 `StableWorkspaceApp` 里、绑定当前工作区，Agent 中心页没有 Home 工作区的服务上下文；且若从普通入口把 Home 当工作区冷恢复，会丢 `agentMemory` 与 Raft 工具、退回项目记忆（与"Home 会话只从 Agent 列表进入"的约束冲突）。二期需要：Home 会话的宿主侧恢复入口（带 `agentMemory`/`officialMcpServers`）+ 为 Agent 中心页构造 Home 工作区上下文，或改为基于绑定的工作区分类派生。

### 验收（T6 部分）

自动化：store/actions 4 项测试（刷新失败不清空旧数据、开始/暂停后刷新、提交失败不回列表、提交中不重复提交、token 不进 store）。**入口位置（顶部一级入口，与自动化/插件市场并排）**；**界面本身（布局、交互、中英文案显示）未经实际运行验证，放 task #8 由有条件的人点一遍**：接入表单各错误提示、列表两种暂停的显示、异常暂停后点开始、详情页打开 Home 文件夹。

## 二期 A1：会话与管理动作的服务层（task #11）

上游依据：二期需求线程（#zcode-raft-integration:a517415a，lyonliang 2026-10-01 拍板）；会话持久化核实结论（2026-10-01 注记见「主会话重建」节）。

### 行为

三个管理动作 + 懒建会话 + 宿主侧恢复入口 + 三个界面接口。全部只在服务层（packages/services/raft-agents），UI 由 B1/A2 接。

**1. 三个管理动作**（lyonliang 语义）：
- **重启**：停值守（如在运行）→ 新建主会话（同 Home、同 `agentMemory`/`officialMcpServers`）→ 锁内改绑 `mainSessionRef`、代次重置 1 → 原为 Running 则自动恢复值守。旧会话不删除（历史保留，供会话视图回看）。进行中的 turn 被放弃，恢复口径与崩溃一致（收件日志 + 下次 drain 补查）。
- **重置**：同重启，但在新建会话前先清 Home 的**记忆面**（根下 `MEMORY.md`、`AGENTS.md`、`notes/` 整树）并按初始模板重建（复用 T5 初始化的"只写缺失"语义，删除后即全新）。**不动** Home 内其他内容（如 `projects/`）、不动凭据与绑定。
- **删除**：停值守 → `session/close` 关闭主会话（产品会话归档；不做跨进程删库行）→ 删绑定记录与本地 profile（复用 removeBinding 既有路径）→ 按归属判定删 Home → 返回 Home 处置四态与 UI 提示所需信息（raftOrigin、agentName），由 UI 展示"请到 Raft 侧撤销 token"。Home 删除的守卫（评审定稿，线程 cb4426cd）：
  - 传入路径本身是符号链接 → 拒绝（防 realpath 把删除引到链接目标整树）；
  - 拒绝文件系统根、用户主目录、数据根目录及各自的上级；
  - **归属判定**：绑定时在 Home 根写归属标记 `.zcode-agent-home`（内容 = bindingId，目录不存在或为空才写，独占创建），整删仅当标记内容与 bindingId 一致，或 Home 恰为默认位置 `<数据根>/agents/<bindingId>/workspace`（兼容加标记前建的旧绑定）；
  - 归属不成立（用户自选目录 / 旧绑定无标记 / 标记不匹配）→ 只清记忆面三处 + 标记，**保留目录**；
  - **返回四态**（`RaftAgentRemoveHomeOutcome`，shared zod 契约）：`deleted`（整删；目录本就不存在也归此，终态等价）/ `kept_memory_cleared`（归属不成立只清记忆，界面提示"已保留你的目录"）/ `untouched`（`reason: not_requested | refused`——未请求删除或被守卫拒绝，Home 确实未动过）/ `failed`（处置中途失败，**Home 可能已被删一部分**，界面提示"请手动检查"，不得声称未改动）。

**2. 预建会话改懒建**：createBinding 不再预建主会话（消除空壳 Session-not-found，见「主会话重建」节更正注记）；`mainSessionRef` 为空的绑定在首次 startWatch 时创建会话（dfcd362 自动重建路径保留为兜底）。原先的预建步骤模块 `app/mainSessionProvisioning.ts` 随之删除（懒建后无生产引用）；懒建与重建共用「锁外创建 + 锁内条件改绑」段（`app/sessionSwap.ts`，三个调用方同语义）。

**3. 宿主侧恢复入口（B3 依赖）**：`openAgentSession(bindingId)` —— 确保主会话存在（懒建）→ `resumeAgentSession`（带 `agentMemory`/`officialMcpServers`，防退回项目记忆）→ 返回会话坐标 `{sessionId, workspacePath}`。渲染层用坐标挂现有会话视图；无论 B3 走"构造 Home 工作区上下文"还是"绑定推导分类"，本入口形状不变。

**4. 界面接口（四个）**：
- **凭据预核验（只核验、不保存，A2 向导第 4 步确认摘要用）**：`verifyCredential(input)` —— 用临时 profile 目录走 login + whoami（`destroyProfile` 收尾，无持久残留），返回服务端认定的身份 `{agentId, agentName?, serverUrl, serverId}` 或一期同族错误码（TokenInvalid/IdentityMismatch/CredentialCheckFailed/OriginInvalid/CliMissing…）。token 仍只经 stdin 进 CLI 子进程，不落盘、不进返回值。agentName 取 whoami/login 可得字段；描述类字段 whoami 不提供则不返回，UI 不硬编码占位。
- **记忆只读**：`listMemoryFiles` / `readMemoryFile`，限定该绑定 Home 的记忆面（根下 `MEMORY.md`/`AGENTS.md` + `notes/**`）；realpath 两侧包含判定（防符号链接逃逸）；单文件内容上限 512KB（超出截断并标志）。无任何写路径。
- **本机已有凭据枚举**：`listLocalCredentials` 读 `raft/profiles/*/credential.json` 的**非敏感字段**（schemaVersion/serverUrl/serverId/agentId/agentName/createdAt）；`apiKey` 字段在适配器内解析后即弃，不进任何返回值、日志、模型上下文；`boundBindingId` 标记已被现有绑定占用（唯一性约束下不可重复接入）。
- **状态投影扩展**：`RaftAgentListItem` 增 `activity`（`lastActivityAt`/`lastActivityKind`/`memoryLoaded`/`pendingApprovals`）。`pendingApprovals` 在 yolo 值守下恒 0（无人工审批面）；turn 级粒度（开始/完成）待 B2 活动事件接入后**追加字段**，不改动现有形状。

### 不变量

1. 三个动作都在 store 锁与换代锁内改绑 `mainSessionRef`；改绑仅在与读到的旧值一致时写入（防并发双写，沿 dfcd362 先例）。
2. 重置/删除的文件操作仅限该绑定 Home 内；重置只碰记忆面三处，删除整 Home 前先过归属守卫（符号链接拒绝 / 受保护根及其上级拒绝 / 归属标记或默认位置判定，见行为 1）；均先 realpath 判定再动手。
3. `listLocalCredentials` 与 `readMemoryFile` 是纯读接口，不产生子进程、不触网。
4. 懒建后 `mainSessionRef` 为空是合法持久态（保存未开始的绑定）；wake 链路对空 ref 的绑定不可达（未 Running 无端点）。
5. 一期安全红线全部延续：token（apiKey）不进返回值/日志/argv/上下文；子进程净化环境；fail-closed 语义不变。

### 失败语义

| 动作 | 失败码 | 语义 |
| --- | --- | --- |
| restart/reset | NotFound / SessionCreateFailed | 新会话建不出来时保持原绑定原会话不动（原子性：先建后改绑） |
| reset | MemoryResetFailed | 记忆面清理失败（部分删除时如实报告；可重试，重置幂等） |
| delete | NotFound | 绑定不存在 |
| readMemoryFile | NotFound / OutsideMemorySurface / Unreadable | 越出记忆面在执行边界拒绝 |
| openAgentSession | NotFound / SessionResumeFailed | resume 失败不自动重建（本接口语义 = 打开已有；空 ref 时先懒建） |

### 验收（A1 部分）

单测覆盖：重启/重置的改绑与代次重置（含 Running 态自动恢复）、重置只清记忆面三处（projects/ 保留）、删除的停值守→关会话→清理顺序与失败中断、删除归属守卫（符号链接拒绝且目标保全 / 受保护根拒绝 / 用户自选目录只清记忆保留 + `kept_memory_cleared` / 归属标记或默认位置成立才整删 + `deleted` / 拒绝与未请求映射 `untouched`）、懒建（createBinding 无会话副作用、首启创建）、记忆只读的边界（越界路径/符号链接/大小上限）、凭据枚举不含 apiKey、openAgentSession 恢复入口带记忆与 MCP 配置、activity 投影字段。

## 二期 A3：处理后再确认、发送去重与回执（task #13）

上游依据：二期需求线程（#zcode-raft-integration:a517415a）；设计线程 #zcode-raft-integration:59b3e306。服务端与命令行补丁在 fork `1WorldCapture/raft-source` 分支 `feat/agent-api-claim-ack`，命令行版本 `0.0.24-zcode.1`。本节只描述 ZCode 工具适配器（`apps/zcode-cli/packages/raft-agent-tools`）的切换；T4 不变量 4、6 在新命令行下被本节取代，旧命令行下照旧。

### 命令行能力（fork 新增，旧命令不变）

- `raft message claim`：输出与 `message check` 相同的规范文本，**不确认**；有消息时末尾一行固定前缀 `Claim-Ack: <token>`（token 是本批确认 id 的 base64url，不含秘密）。确认前再次 claim 返回同一批（服务重启后也是），语义"至少一次"。
- `raft message ack`：token（或整行 `Claim-Ack: ...`）从 **stdin** 读入，可重复调用。
- `raft message send --idempotency-key=<key>`：同一个键已提交过 → 返回原消息，成功行与普通发送完全相同（不过新鲜度门、不再插入）。
- `raft message receipt <key> --json`：`{"status":"sent","message_id":...}` 或 `{"status":"not_found"}`（未提交，可用同一个键安全重试）。

### 能力探测

适配器首次调用时执行一次 `raft --version`（同样固定 `--profile` 前缀与净化环境），版本串含 `-zcode.N`（N≥1）即启用新流程，结果缓存到进程结束；探测失败或旧版本 → 第一期行为（`message check`、发送不带键），不报错。若命令行是新的但服务端尚未部署补丁（claim 返回"路由未登记"），本进程回落第一期路径。

### 行为

**message_check（claim → 落盘 → ack）**
1. `message claim` 取一批；按行精确剥除 `Claim-Ack:` 行，该行**不进**模型输出、收件日志、应用日志。
2. 按消息切块（以 `[target=` 开头的行起一条），用 `(target, msg)` 去重：已记入收件日志的消息不再交给模型（但照样 ack）。已投递集合 = 进程内集合 + 首次调用时从收件日志近 7 天条目载入。
3. 新消息先写收件日志（有限重试，同 T4）。**写成功才 ack**；写失败 → 不 ack、照常把消息交给模型并上报（下次 claim 会再给，宁重复不丢）。
4. ack 失败只记告警（不含 token），结果照常返回；下次 claim 重复给到的消息由第 2 步去重。
5. 本批全是重复 → 返回"没有新消息"；`has_more` 提示改写为"请再次调用 raft_message_check"。

**message_send（键 + 回执 + 一次安全重试）**
1. 每次工具调用生成一个键 `zcode:<bindingId>:<uuid>`，随 `--idempotency-key=` 发送（`sendDraft` 同样带键）。
2. 结果不确定（超时被杀且无成功行、`UNKNOWN`/`CANNOT_CONFIRM`）→ `message receipt <key> --json`：`sent` → 按成功返回（附 messageId）；`not_found` → 用**同一个键**原样重试一次（服务端去重保证不会发出两条）；重试仍不确定或回执查询失败 → unknown（同 T4，不再自动重发）。
3. 被扣成草稿（`SEND_HELD_AS_DRAFT`）不变：交还模型决定，不自动重试。

### 不变量

1. token 与 ack 凭据都不出现在 argv、模型可见输出、收件日志、应用日志；ack 凭据只经 stdin。
2. 收件日志仍是唯一的"已交给模型"记录；ack 永远晚于成功落盘。
3. 一次工具调用最多两次发送请求，且共用一个键。
4. 旧命令行（无 `-zcode.N`）行为与第一期逐字节一致。

### 验收（A3 部分）

单测（假 CLI）：claim 后先落盘再 ack、ack 走 stdin 且 argv 无 token；`Claim-Ack:` 行不进返回文本与日志；落盘失败不 ack；重复 claim 的同批消息第二次不交给模型但仍 ack；发送带键、不确定时查回执（sent 不重发 / not_found 同键重试一次）；旧版本回落第一期行为。
真机（服务端部署后）：claim 不 ack 再 claim 拿到同一批；去重重发不产生第二条；回执 sent/not_found。
