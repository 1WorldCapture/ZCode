# 端到端验收清单（第一期，task #8 / task #10）

依据：`work/zcode-raft-phase1-spec.md` §13 十条验收场景 + §14 已知限制 + 评审遗留项。
集成分支：`feat/raft-agent-binding`（含 `feat/raft-agent-ui` 全部内容）。

## 0. 环境与角色

| 项 | 值 / 负责 |
| --- | --- |
| 验收机器 | lyondeMacBook-Pro（macOS arm64）——Dev-developer 运行所在机，即 lyonliang 的本机 |
| Electron | v41.0.3 arm64 已验证可执行（`node_modules/electron/dist`） |
| ZCode 版本 | 集成分支 production build（`packages/desktop` 下 `pnpm build` 产物 `out/`，已构建并通过冒烟） |
| 启动命令 | `cd ~/workspace/ZCode-raft/packages/desktop && ZCODE_RAFT_CLI="$HOME/workspace/raft-source/packages/cli/dist/raft.js" ../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`（干净 CLI 0.0.24 = raft-source f7682db 构建，净化 env 下已验证；**勿用 PATH 里的 raft**，那是 agent transport 包装器） |
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

- [ ] **绑定删除无外部入口**（15:49 发现，二期）：removeBinding 服务接口只在 Electron renderer↔main 的 MessagePort 上，UI 无删除按钮 → 无任何外部触达路径；静态改 bindings.json 会被内存态回写。二期补 UI 删除入口。另：removeBinding 不删 Agent Home、不关预建主会话（第一期范围，已与 PM 对齐为预期行为）。

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

## 5. 验收记录

### 2026-09-30（执行：lyonliang 点界面 / Dev-developer 盯日志）

- **S1 填表接入 — 通过**（TestAgent-1 / TestAgent-2 双绑定均成功）。
  - 证据：lyonliang 截图（attachment 9946a839）；`~/.zcode/raft/bindings.json` 两条记录（f2b0a9f0=TestAgent-1 agentId de7056f5…、80152adf=TestAgent-2 agentId be4a0188…），origin `http://grokbot.tailf3efbe.ts.net:3001`，serverId 与本机 daemon b0cdf001 一致。
  - 安全面：bindings.json 无 token 字段；ZCode 与 bridge 进程 argv 无 `sk_agent`（bridge 用 `--profile raft-<slug>` 传身份，非 token）；Agent Home（`~/.zcode/agents/<bindingId>/workspace`）仅 MEMORY.md/AGENTS.md，无凭据文件。
  - 说明：`~/.zcode/raft/profiles/<slug>/credential.json` 含 `sk_agent_*` 明文——这是官方 CLI 的标准凭据存储（`raft agent login` 写入、`RAFT_PROFILE_DIR` 指向），spec §95 设计内（"Raft 凭据留在 profile 目录，由 CLI 自己读取"）；profile 目录 ≠ Agent Home。非违规。
- **S3 保存不开始 — 通过（弱证据）**：接入完成（21:09）到点"开始"（21:10:58）期间 ps 确认无任何 bridge 进程；点开始后两条 bridge 进程拉起（94006/94046）。收件未读的负向证据（当时无 inbox 日志）未单独留存——因 Lyon 直接点了开始，观察窗口短。补验可选：暂停后再观察一轮。
- **S4 开始→@→回复 — 修复三轮后链路打通（21:49），等 PM 重测收口**：lyonliang 21:10:58 点开始；bridge argv 核验通过（干净 CLI、`--expected-agent` 与绑定 agentId 一致、`--adapter-instance`=bindingId、`--activity-channel-endpoint` 显式传递 = e04a5ee 修复生效）。PM 21:11:12 @TestAgent-1 后无回复，定位出三层问题并逐一修复：
  1. **可观测性缺失**（commit 4fc4863）：raft 运行时未接 logger、bridge stdout 被丢弃 → 接线 `createServiceLogger("raft-agents")` + bridge stdio 按行 redact 落日志；ACK detail 丢失真实原因 → `ackToOutcome` 拼接 reasonCode+message，拿到真相 `FOREIGN KEY constraint failed`。
  2. **重启后 Session not found**（commit dfcd362，PM 批准提前进第一期）：内嵌 agent 会话事件存储为内存态，ZCode 重启后 mainSessionRef 悬空 → startWatch resume 失败时自动重建主会话并锁内改绑（代次重置 1，日志记新旧 sessionId；对话上下文丢弃、Home 记忆保留，语义已写入 SPEC）。
  3. **V4 durable admission 外键失败（S4 真正根因，commit 10ceaac）**：主会话经 legacy session/create 创建且未传 persistence，协议侧记 "immediate"，而 session 行只在首个输入的统一持久化边界写入；V4 admission 对非 deferred 记录跳过该边界直接 insert `session_input` → 外键（→session.id）失败，表现为唤醒端点持续 409 busy。修复：适配器固定 `persistence:"deferred"`，首个 V4 输入（drain/wake）先走 `ensureSessionPersistedForExternalActivity` 落 session 行。
  - 21:49 run4 实测：两绑定自动重建（sess_2225c3db / sess_0be20bef，均落库 db.session）→ `raft watch started`（drain 投递成功）→ 积压 wake hints（seq 3509-3521）逐条注入 `outcome:ok, proofLevel:wake_injected` → 会话 turn 启动（GLM-5.3 请求发出）→ **FK 失败归零**。UI 修正（feat/raft-agent-ui 81a2f5f，顶部一级入口）已随本次重启合入（merge 47e18c8 之后）。
  4. **权限模式缺失（第五层，commit 432553a）**：run4 里 turn 启动后工具调用不执行——V4 缺省权限模式对 MCP 工具调用要求人工批准，值守会话无人批准 → 两 agent 各挂 pendingPermissions=2，`raft_message_check` 卡 running（grokbot 从服务端 nginx 日志独立对上：hint 已到 bridge、但无任何读收件箱的 `/events` 请求）。修复 = 无人值守权限模型三层（SPEC「主会话权限模型」节）：`mode:"yolo"`（create 锁定 + 每次投递显式带，堵空草稿冷恢复角落）+ 注册级 `toolAllowlist`（Raft 六工具 + Read/Write/Edit/Glob/Grep/TodoWrite；无 Bash、无 ApplyPatch）+ 新 wire 参数 `confineFileToolsToWorkspace`（文件工具读写锁定 Agent Home 内，执行边界拒绝、压过 yolo；读也限——防全盘读+发消息外带）。采纳 grokbot 评审意见：白名单必须含文件工具（Agent 自维护记忆），但写入须限 Home、不放 Bash。
  5. **插件宿主入口不兼容（第六层，commit fd8c6b2，15:00 重测暴露）**：第五层修好后工具调用真正打到 MCP 连接上，`raft_message_check` 18/22 次 `CONNECTION_CLOSED`——app-server 经官方插件宿主拉起 raft_agent_tools（import 构建产物后调用导出的 `main()`，plugin-host-command.ts），而插件入口只顶层自启、未导出 main → 宿主报 `Plugin server does not export main().` 退出子进程；顶层自启又让服务存活一瞬，形成"连上→片刻断"竞态（run4 前调用卡在权限层从未触碰连接，竞态被掩盖）。修复：照 node-repl-host 惯例 `export async function main()` + `isDirectMcpEntrypoint` realpath 直跑守卫；补两条宿主路径回归测试（import+main 驱动构建产物、仅 import 不自启）。grokbot 认领（T4 端到端只直跑 `node server.js`，走不到宿主 import 路径）。15:00 重测同时确认第五层生效：`pendingPermissions=0`、积压 15:00:02 全量读走（14KB/8KB）、唤醒到读取 9 秒（grokbot nginx 时间线）。

### 2026-09-30 15:14–15:24（执行：lyonliang+PM / 盯日志：Dev-developer + grokbot）

- **S4 开始→@→回复 — 通过**（15:14:26 重启修复版后）：
  - TestAgent-1：15:00:58 被 @（旧实例连接抖动未能回复）→ 重启后积压处理补复，15:16:03 频道回复"我是 TestAgent-1，正在通过 ZCode 运行"，并主动补复 PM 13:11 请求与 Dev-developer 14:12 自测（回到原线程 99a13660，15:17:57）。
  - TestAgent-2：15:14:58 被 @ → 15:16:27 在 lyonliang 消息的**线程内**回复"我是 TestAgent-2"。
  - host 侧（db tool_usage）：重启后 check/read/send 全 completed、零 CONNECTION_CLOSED；收件日志双绑定落盘（`~/.zcode/raft/inbox-logs/<bindingId>/` 各 2 条，T4 不变量生效）。
  - nginx 侧（grokbot）：15:15:49 首次 `v2/send` 被"新鲜度门"扣为草稿（期间 PM 15:15:08 新消息）→ agent 读取新消息后 15:16:03 二次发送成功——**扣草稿→交还模型→改后重发的设计行为首次实测验证，无自动重试**。
- **S7 双 agent 身份不串 — 通过（PM 15:16:35 发起）**：两 agent 各自会话独立回复（sess_2225c3db=TestAgent-1 / sess_0be20bef=TestAgent-2，db 中 send 各来自对应会话）；TestAgent-2 15:18:25 频道回复"我是 TestAgent-2"，TestAgent-1 以补复形式多次自报身份。会话、profile、Home 互不串。
- **S5 忙时排队 — 通过**（PM 15:20:52/54 发 A、B，15:23:31 收口）：
  - 两条均落地：15:23:26 "收到 A"+记忆文件总结（seq 3572）、15:23:31 "收到 B"（seq 3573）——频道恰 2 条，**无重复、无丢失**。
  - 不打断：A 的 turn 内工具链连续执行（check→Glob→send→read→send→…→Edit 15:23:42 自更新记忆），B 到达后未中断该 turn；B 的处理在 A 之后同一流程完成。
  - held 设计行为再次生效：db 中 TestAgent-1 共 4 次 send completed（15:21:25/15:22:42/15:23:17/15:23:29），前两次频道零落地 ⇒ 被新鲜度门扣为草稿（目标有未读），模型 read 清未读后重发成功——扣草稿≠失败，无重复投递。
  - commandId 幂等：PM 两条 wake 对两个 bridge 均有投递（含 duplicate:true 重放，host 日志 fast_reconcile reinjected=2），频道无重复回复。
  - 附带首测：`confineFileToolsToWorkspace` 生产首次实测——15:21:14 Glob 越出 Home 被拒（`permission_denied: File tool access is restricted to the workspace root`），6 秒后 in-root 重试成功（设计内可恢复拒绝，无逃逸）。
  - 附带：TestAgent-2 bridge 同步收到同频道 wake，check 后不动作（非@自己）——频道投递语义正确。
- **S3 保存不开始 — 通过（强证据版，15:45 保存 TestAgent-3 后核验）**：①ps 中 bridge 恰 2 个（TestAgent-1/2），无 TestAgent-3（fd56b3b3）；②收件日志目录 `~/.zcode/raft/inbox-logs/` 无 fd56b3b3（无读取）；③nginx（grokbot）：15:45:19 仅一次 `GET /internal/agent-api/`（保存时身份核验），此后零轮询。bindings.json 中 TestAgent-3 desiredState=ReadyStopped。附注：保存时主会话已预建（sess_843dafce，gen 1）——provisioning 设计内行为，无运行、无外部效应，不违反判据。
- **S2 错 token 拒绝 — 通过（16:09–16:11，TestAgent-4 变体）**：表单填 TestAgent-4 ID + TestAgent-1 真实 token → 服务器侧 16:09:46 身份核验 200（token 本身有效）→ CLI 判明归属 agent 与填写 ID 不符 → 表单报"这个 Token 属于另一个 Agent 或另一个服务，请核对 Agent ID 和服务地址"（IdentityMismatch 中文文案，lyonliang 截图 f413b196）。**无残留**（对比提交前基线）：bindings.json 仍 3 条、profile 目录无新增（失败路径清理）、Home 无新增、收件日志无新增；TestAgent-1/2 已有绑定数据不变（Running/session/gen 未动）。附带：首次误填格式非法 token 验证了本地格式校验路径（未联网即拒，服务器零请求）。

### 2026-09-30 16:19–16:23 B 轮（暂停→积压→重启→点开始；执行：lyonliang+PM / 盯日志：Dev-developer + grokbot）

- **S9 积压处理 — 通过**：16:19:12 暂停（bridge 进程归零、ReadyStopped ×2、服务器侧推送流 16:18:42/46 断开后零轮询——三方核验起点干净）；PM 16:19:20/24 两条积压入库未读；16:21 重启后列表"已停止"→分别点开始→"运行中"（截图 a8965b61，含状态圆点 UI）；**drain 点开始后 1–6 秒拉到积压**（16:21:10/15，服务器侧 16:21:26/28 读走清空队列）；两条积压各恰一条回复（16:22:06 / 16:22:45），内容均准确说明"重启后才看到"。
- **S6 记忆仍在 — 通过（含自动恢复口径拆分）**："自动恢复值守"（desiredState=Running 重启即自动拉起）已于 15:14 重启实测（S4 记录）；本轮强化"记忆仍在+补查"：TestAgent-1 引用 MEMORY/notes 内容（含"不代答 TestAgent-2"约定）；TestAgent-2 给出最强证据——15:29 **预写**笔记"B 轮会被暂停、PM 会发积压、恢复后要回复"，本回合读回并照做（写入→重启→读回→指导行为闭环）。会话恢复：sessionId 不变、generation 6→7 换代（resume 而非重建）。
- **发送超时修复（merge 21225de）实测生效**：send 全部秒级完成（5.4s/7.6s/4.4s），无 60s 白等、零 CONNECTION_CLOSED；TestAgent-2 首次 send 被新鲜度门扣草稿后重发（host db 与 grokbot 服务器侧时间线互证）。另两处 Edit 小错（文件忙）模型自重试成功。
- 备注（更正）：TestAgent-1 回复中提到 commit 号 fd8c6b2 **不是幻觉**——出自 Dev-developer 15:13:36 发在 99a13660 线程的消息（ab00f41c），其补复正是在该线程内，属读线程上下文的合法引用。
- 记忆无串核验（S7 附加项）：直读 TestAgent-1 的 Home 记忆文件（`~/.zcode/agents/f2b0a9f0…/workspace/notes/work-log.md`）——内容全为自身经历（自身 10 次工具失败、自身 held 草稿、自身补复）+ 频道公开消息可得的事实（"第六层"/fd8c6b2 引用来源见上）；"send 结果不确定时的处理经验"为其亲历（TestAgent-2 的同类经验在各自 Home，互不渗透）；其记忆还记有"未代答发给 TestAgent-2 的消息（验收要求身份不串）"。**结论：无串记忆。**

