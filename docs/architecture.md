# 架构

本文描述 dsh-im-manager 的分层、消息数据流、会话映射、访问控制与重启语义。
**接口契约以 [contracts.md](contracts.md) 为准**；本文只做实现视角的说明，两者冲突时以 contracts.md 为准。

## 1. 定位

dsh-im-manager 是一个**独立进程**的 IM 网关：把飞书 / 钉钉 / 企业微信 / 微信（个人）的消息转成 DSH SDK runtime 的 prompt，再把 Agent 的回复发回对应会话。
它不属于 DSH 的某个具体 channel 功能，而是「一个 IM 前端 + 一个 DSH SDK runtime」的组合。

- 一个 gateway 进程只管理**一个 DSH runtime 子进程**（`dsh --profile sdk`），多个渠道共享它。
- 每个渠道一个账号实例；`accountId` 字段已预留，v1 不做同渠道多账号。
- gateway 由 DSH profile bundle 启动（`src/dsh-plugin.js`），每个工作区一个 gateway + 独立 SDK runtime。

## 2. 分层

```
┌─────────────────────────────────────────────────────────────────────┐
│  IM 平台：飞书 / 钉钉 / 企业微信 / 微信（个人）                        │
└───────────────▲─────────────────────────────────┬───────────────────┘
                │ 出站 send(ReplyTarget, Outbound) │ 入站（webhook / 长连接 / stream / 长轮询）
                │                                 ▼
┌───────────────┴─────────────────────────────────────────────────────┐
│  src/adapters/<id>/   平台协议 ↔ 内部契约的翻译层（4 个内置渠道）      │
│  - 解析平台事件，归一化为 InboundMessage（正文、sender、mentioned…）  │
│  - 实现 send / startTyping / stopTyping / health                      │
│  - 只依赖 Node 内置模块、ws、fast-xml-parser、各平台 SDK              │
│  - weixin 例外：iLink 长轮询 + 扫码凭据，不注册 HTTP 路由             │
└───────────────┬─────────────────────────────────────────────────────┘
                │ emit(InboundMessage)
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/core/   与平台无关的编排层                                       │
│  - 去重、访问控制（DM policy / 群策略 / allowFrom）                    │
│  - 聊天内命令 /new /status /help /id                                  │
│  - 会话映射（conversation key → sessionId）与串行/并发调度            │
│  - 回复编排：收集 assistant 文本、分片、降级、超时                    │
│  - HTTP 宿主（adapter 注册 webhook 路由）、配置、日志、状态文件        │
└───────────────┬─────────────────────────────────────────────────────┘
                │ bridge.prompt / ensureSession / onEvent / onStatus
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/bridge/   唯一与 DSH runtime 通信的边界                          │
│  - spawn `dsh --profile sdk`，stdio 上跑换行分隔 JSON-RPC 2.0         │
│  - 会话 resume、崩溃自动重启、优雅关闭                                │
└───────────────┬─────────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DSH SDK runtime（子进程）：Agent loop / 工具 / 会话持久化             │
└─────────────────────────────────────────────────────────────────────┘
```

`bin/` 与 `src/cli.js` 只做诊断/终端入口（`doctor` / `status` / `pair` /
`weixin login|status|logout`），不承载业务逻辑。

各渠道传输方式：

| 渠道 | 入站 | 出站 | 需要公网 |
| --- | --- | --- | --- |
| 飞书 | WS 长连接 / webhook | 开放平台 API | webhook 模式需要 |
| 钉钉 | Stream / webhook | sessionWebhook | webhook 模式需要 |
| 企业微信 | 智能机器人 WS / 自建应用回调 | 回复串 / 应用消息 API | webhook 模式需要 |
| 微信（个人） | iLink 长轮询 | iLink 回复接口 | 不需要 |

`weixin` 不占用 HTTP 端口（`ctx.http` 对它不可用），也没有 webhook；它从
`<gateway.stateDir>/channels/weixin/credentials.json`（`0600`，扫码登录生成）读取登录态，
用长轮询拉取新消息。

## 3. 一条消息的生命周期

### 3.1 入站

1. adapter 收到平台事件（webhook POST、长连接推送，或 `weixin` 的长轮询结果）。
   webhook/长连接类渠道**先按平台要求快速应答**（微信 5s、飞书 3s 等），再异步处理；
   `weixin` 由轮询循环直接产出消息，无平台应答时限。
2. adapter 归一化为 `InboundMessage`：
   - `text` 已去掉 @机器人 前缀；
   - `mentioned` 在群里正确表示是否 @ 了机器人（DM 恒为 `true`）；
   - 图片/文件等附件填 `url`（可直接下载的也可由 adapter 落到 `stateDir/media/` 后填 `path`）；
   - `messageId` 稳定且平台唯一，供 core 去重。
3. adapter 调 `ctx.emit(inbound)` 交给 core。

### 3.2 core 处理

```
emit(inbound)
  ├─ 去重（同一 messageId 只处理一次）
  ├─ 访问控制
  │    ├─ DM：access.dmPolicy = open | allowlist | pairing
  │    └─ 群：groups.enabled / groups.allowFrom / requireMention
  ├─ 命令分发（/new、/status、/help、/id；/stop 目前只回复「不支持中止」；不进入 Agent 上下文）
  └─ 普通消息 → 取会话 → bridge.prompt
```

被访问控制拒绝的 DM 在 `pairing` 模式下会收到一条带 6 位配对码的提示；
群消息在未开启群聊或未命中 allowFrom 时**静默丢弃**，避免在群里刷屏。

### 3.3 一轮回复

1. core 用会话键取（或创建）`sessionId`，`bridge.ensureSession(sessionId)` 确保 DSH 端已打开。
2. `bridge.prompt(sessionId, blocks)` 提交本轮输入（文本和图片）。
3. 期间 DSH 通过 `session.event` 推送事件：
   - `assistant/message`：收集 `data.message.content` 中的 text blocks；
   - `turn/end`：本轮结束。`reason.completed` 时取最后一条非空 assistant 文本作为回复；
     其他结束原因发送错误提示（`showErrorDetail` 控制是否带原因）。
4. 回复按 `reply.chunkChars` 分片，逐片调用 `adapter.send(target, { text, format })`；
   片数超过 `reply.maxChunks`（默认 6，0 为不限）时，保留前 `maxChunks-1` 片并补一句
   「其余 N 段已省略」。
5. `send` 抛错时 core 记录并尝试一次纯文本降级；纯文本仍失败则不吞错，向上抛出。
6. 完成但无文本时发送 `reply.emptyText`；一个 turn 超过 `dsh.turnTimeoutMs` 未结束则发超时提示并保留会话。

支持 typing 的渠道在 `session.status=running` 期间显示「正在输入」。

## 4. 会话映射

### 4.1 生效范围：绑定单位是「工作区」，会话是工作区内的对话

一个 gateway 实例只服务**一个工作区**，这是本项目的核心作用域约定：

| 维度 | 单位 | 说明 |
| --- | --- | --- |
| 安装 / 配置 / 进程 | **工作区** | 一个 `serve` 进程 = 一份 config = 一个 `dsh.cwd` + `dsh.home` |
| Agent runtime | **工作区** | 一个 DSH SDK 子进程；工具、文件权限、审批都落在这个工作区 |
| 渠道账号 | **工作区** | 五个 adapter 的账号与凭据属于该实例 |
| 对话上下文 | **会话** | 工作区内每个 IM 会话一个 DSH session，互不串上下文 |
| 访问身份 | **会话/发送者** | allowFrom / pairing 决定谁能进入这个工作区 |

因此 IM channel 不是绑定到某一个 Session，而是**绑定到工作区**：工作区内的不同聊天、
不同渠道各自拥有独立会话（`/new` 可轮换），但它们共享同一个工作区、工具和文件视图。
反过来，一个 Session 永远不会跨工作区复用。

**为什么不把渠道绑到单个 Session**：多人/多群共用一个会话会串上下文、串审批、串隐私，
并发也无法隔离；而「一个工作区 = 一个实例」让权限边界与文件边界重合，最容易审计。

配对也遵循同一作用域：配对码和 allowlist 持久化在该工作区实例的 `<stateDir>/pairing.json`，
批准动作（CLI `pair` / DSH 工具 `im_gateway_pair`）必须作用到同一个实例；矩阵式多工作区
各自维护自己的 allowlist，跨工作区批准无效。工作区本地配置（`.dsh-im-manager/config.json`）
让「在哪个目录执行命令」与「操作哪个工作区」保持一致。

**多工作区怎么办**：v1 采用「一工作区一实例」——不同项目各自一份 config、一个 `stateDir`、
一个 HTTP 端口（如需 webhook）。`sessions.json` 会记录工作区指纹
（`{cwd, dshHome}`）；如果同一个 `stateDir` 被另一个工作区误用，加载时会丢弃旧会话绑定并告警，
避免把 A 项目的聊天恢复到 B 项目的文件上下文。未来若需要单进程多工作区，再引入显式
`workspaces` 路由，并把工作区 id 加入会话键前缀（届时需要迁移 sessions.json）。

- 会话键：`<channel>:<accountId>:<conversationType>:<conversationId>[:<threadId>]`。
  例：`feishu:feishu:group:oc_xxx`、`dingtalk:dingtalk:dm:123`、`weixin:weixin:dm:<wxid>`。
- 映射持久化在 `<stateDir>/sessions.json`，文件形如
  `{ "version": 2, "workspace": { "cwd": "...", "dshHome": "..." }, "sessions": { "<key>": { "sessionId": "...", "createdAt": 0, "lastUsedAt": 0 } } }`。
  `workspace` 是防跨工作区复用的指纹，见 §4.1。
- 同一会话内消息**串行**处理（保证同一轮上下文不交错）；不同会话可并发，
  总并发上限 `gateway.concurrency`（默认 4）。
- `/new` 为该会话生成新的 `sessionId`、更新映射，并通过 `session/working-directory/get`
  让 SDK runtime 立即把新 session 落盘；旧 session 仍保留在 DSH 的会话持久化中，不会被删除。
  gateway 重启后按 `sessions.json` 恢复映射。
- **Desktop 可见性**：会话持久化在 `<DSH_HOME>/sessions`，但 Desktop 侧栏由宿主内存列表驱动；
  外部进程新建的会话通常需要刷新/重开 Desktop 才会出现。`dsh-im-manager sessions` 可随时查看映射；
  `/sessions` 在 IM 里返回同一份列表。

## 5. 访问控制的位置

访问控制在 core 完成，adapter 不重复实现。它发生在**去重之后、命令分发之前**：
被拒绝的消息既不会触发 Agent，也不会执行 `/new` 等命令。具体语义见
[security.md](security.md) 与 [contracts.md](contracts.md) §6。

## 6. Bridge 与重启语义

- 协议：stdio 上换行分隔的 JSON-RPC 2.0；stdout 只允许协议帧，stderr 进日志。
  方法：`initialize`、`session/prompt`、`session/resume`、`session/wait`、
  `session/working-directory/get|set`、`shutdown`。
- 启动时 `initialize`（`cwd`、`provider`、`model`、可选 `reasoningEffort` / `maxTokens`），
  失败则 gateway 启动失败并报错。
- runtime 子进程异常退出后按指数退避自动重启（1s → 30s，带 jitter）；
  已打开过的会话在下次使用前用 `session/resume` 恢复。
- 退出顺序：gateway 收到 SIGINT/SIGTERM → 停止接收新消息 → `adapter.stop()`
  （webhook/长连接断开）→ `bridge.stop()`：发 `shutdown`，2s 未退出 SIGTERM，再 3s SIGKILL。
- 状态机：`starting` → `ready` →（崩溃）`restarting` → `ready`；退出后为 `stopped`。
  `dsh-im-manager status` 读取状态文件并检查进程存活。

## 7. 与 contracts.md 的对应关系

| 主题 | contracts.md 章节 |
| --- | --- |
| Adapter 接口与入站规则 | §2 |
| HTTP 宿主（webhook 路由） | §3 |
| Bridge 接口与 JSON-RPC | §4 |
| 渠道配置字段 | §5 |
| 访问控制语义 | §6 |
| 会话映射与命令 | §7 |
| 回复编排 | §8 |
| 日志与状态 | §9 |
| 测试约定 | §10 |
| v1 明确不做 | §11 |
