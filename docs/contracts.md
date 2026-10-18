# dsh-im-manager — 内部契约（v1, frozen）

本文件是 **Lead 与各 adapter/bridge 开发者之间的接口契约**。改动契约必须先改本文件并通知
所有实现者，不得只改代码。

## 1. 分层

```
IM 平台  ──adapter──▶  InboundMessage ──gateway──▶  DSH SDK runtime（JSON-RPC over stdio）
   ▲                                                  │
   └──────────────  OutboundMessage ◀── reply ────────┘  session.event / session.status
```

- `src/adapters/<id>/`：只做平台协议 ↔ 契约的翻译。**不得** import DSH 内部包，不得直接调用
  agent/session API；只依赖 Node 内置模块、`ws`、`fast-xml-parser`、各自平台 SDK。
- `src/bridge/`：唯一与 DSH runtime 通信的边界（spawn 子进程 + 换行分隔 JSON-RPC 2.0）。
- `src/core/`：路由、访问控制、去重、会话映射、回复编排、HTTP 宿主、配置、日志。
- `bin/`、`src/cli.js`：命令行入口。

## 2. Adapter 契约

每个 adapter 是 `src/adapters/<id>/index.js` 的默认导出：

```js
/**
 * @typedef {Object} Adapter
 * @property {string} id                     // 'feishu' | 'dingtalk' | 'wecom' | 'weixin'
 * @property {AdapterCapabilities} capabilities
 * @property {(ctx: AdapterContext) => Promise<void>} start
 * @property {() => Promise<void>} stop      // 必须幂等
 * @property {(target: ReplyTarget, message: OutboundMessage) => Promise<SendResult>} send
 * @property {(target: ReplyTarget) => Promise<void>} [startTyping]
 * @property {(target: ReplyTarget) => Promise<void>} [stopTyping]
 * @property {() => Promise<ChannelHealth>} [health]
 */
```

```js
/** @typedef {Object} AdapterCapabilities
 * @property {boolean} text
 * @property {boolean} markdown         // false 时 core 会降级为纯文本
 * @property {boolean} media            // 出站图片/文件
 * @property {boolean} streaming        // 是否支持原地编辑流式输出（v1 不使用，保留字段）
 * @property {boolean} typing
 * @property {boolean} threads
 */

/** @typedef {Object} AdapterContext
 * @property {object} config            // 本渠道已通过 adapter 自身校验的配置（见 §5）
 * @property {(inbound: InboundMessage) => Promise<void>} emit
 * @property {Logger} log               // { debug, info, warn, error, child(scope) }
 * @property {AbortSignal} signal       // gateway 关闭时触发
 * @property {HttpRegistry} http        // 见 §3；无 webhook 需求的 adapter 可忽略
 * @property {string} stateDir          // 本渠道可写目录（已创建）
 * @property {(name: string) => string | undefined} secret // 读取 env: 解析后的密钥
 */
```

```js
/** @typedef {Object} ReplyTarget
 * @property {string} channel
 * @property {string} accountId
 * @property {string} conversationId    // 平台稳定会话 id（单聊/群聊同一命名空间由平台决定）
 * @property {'dm'|'group'} conversationType
 * @property {string} [threadId]        // 话题/回复串
 * @property {string} [replyToMessageId]
 * @property {unknown} [raw]            // adapter 自定义（如 sessionWebhook / response_url）
 */

/** @typedef {Object} InboundMessage
 * @property {string} channel
 * @property {string} accountId
 * @property {string} conversationId
 * @property {'dm'|'group'} conversationType
 * @property {string} messageId         // 平台消息 id，用于去重；缺失时 adapter 必须自行生成稳定 id
 * @property {{ id: string, name?: string }} sender
 * @property {string} text              // 已去掉 @机器人 后的正文；纯附件消息可为空串
 * @property {boolean} mentioned        // 群里是否 @ 了机器人；DM 恒为 true
 * @property {Attachment[]} attachments
 * @property {ReplyTarget} target
 * @property {number} timestamp         // epoch ms
 * @property {unknown} [raw]
 */

/** @typedef {Object} Attachment
 * @property {'image'|'file'|'audio'|'video'} kind
 * @property {string} [url]             // 平台可下载 URL（如已签名临时地址）
 * @property {string} [path]            // adapter 已下载到本地时的绝对路径
 * @property {string} [mimeType]
 * @property {string} [name]
 * @property {number} [size]
 */

/** @typedef {Object} OutboundMessage
 * @property {string} text
 * @property {'plain'|'markdown'} [format]   // 缺省 plain；adapter 不支持 markdown 时应自行降级
 * @property {Attachment[]} [attachments]
 */

/** @typedef {Object} SendResult
 * @property {string} [messageId]
 */

/** @typedef {Object} ChannelHealth
 * @property {'connected'|'connecting'|'degraded'|'disconnected'} state
 * @property {string} [detail]
 * @property {number} [since]           // epoch ms
 */
```

### 2.1 入站规则（adapter 必须遵守）

1. 只 emit **真实用户消息**；忽略机器人自己发的消息、事件回调（v1）、重复事件。
2. `messageId` 稳定且平台唯一；去重由 core 做，但 adapter 也要防平台重投（幂等 emit 不要求）。
3. 群聊里必须正确设置 `mentioned`：@机器人 判定失败时 core 会按未提及丢弃（当
   `groups.requireMention=true`）。
4. 附件能直接下载的，adapter 可异步下载到 `stateDir/media/` 并填 `path`；无法下载时填 `url`，
   core 只把 URL 作为文字提示转给 Agent（v1 不代下载）。
5. 平台回调要求快速应答（如微信 5s、飞书 3s）时，adapter **必须立即应答平台**，再异步
   `emit`。绝不能等 Agent 回复后才应答平台。
6. 出站 `send` 失败抛错，core 会记录并尝试一次降级（去 markdown、缩短）。`send` 不得吞错。

## 3. HTTP 宿主

`gateway.http` 开启时，core 启动一个 HTTP server，并把注册表交给 adapter：

```js
ctx.http.route('POST', '/webhook/wecom', async ({ req, res, body }) => { ... });
ctx.http.publicUrl('/webhook/wecom'); // => 基于 publicBaseUrl 的完整 URL，未配置时为 null
// handler 收到单个对象 { req, res, body }，必须自行写响应：res.writeHead(...).end(...)
// req: node:http IncomingMessage; res: ServerResponse; body: Buffer（core 已读完，上限 2 MiB）
```

- 路由冲突启动时报错。
- adapter 的 webhook 路径必须使用其配置里的 `webhookPath`，默认见 §5。
- v1 不做 TLS；生产建议前置 Caddy/Nginx 反向代理，或用各平台的“长连接/stream”模式。

## 4. DSH Bridge 契约

`src/bridge/dsh-sdk.js` 导出 `createDshBridge(options)`，返回：

```js
{
  async start(),                 // spawn + initialize；失败抛错
  async stop(),                  // 幂等；发送 shutdown，超时杀进程
  async ensureSession(sessionId),// 已打开直接返回；否则先 session/resume，missing 则留给 prompt 创建
  async prompt(sessionId, blocks), // blocks: [{type:'text',text}, {type:'image',data,mimeType}]
                                  // => { messageId }；未 initialize 抛错
  async wait(sessionId),         // session/wait
  onEvent(fn),                   // fn({ sessionId, event })  event: SessionEvent
  onStatus(fn),                  // fn({ sessionId, status: 'running'|'idle' })
  onState(fn),                   // fn({ state: 'starting'|'ready'|'restarting'|'stopped', detail? })
  get state(),                   // 当前状态
  get pid(),
}
```

- 协议：newline-delimited JSON-RPC 2.0；请求 `initialize` / `session/prompt` /
  `session/resume` / `session/wait` / `session/working-directory/get|set` / `shutdown`；
  通知 `session.event`（`{sessionId, event}`）、`session.status`（`{sessionId, status}`）、
  `subagent.started`、`subagent.finished`。
- `initialize` 参数：`{ cwd, provider, model, reasoningEffort?, maxTokens? }`；`dsh.home` 会以
  `DSH_HOME` 注入子进程 env（与 `dsh.env` 合并，显式 env 优先）。返回
  `{ serverInfo: { name: 'deepseek-harness-sdk-runtime', version } }`。
- 子进程 stdout 只用于协议；stderr 转发到 logger。退出后按指数退避自动重启（1s→30s，
  jitter），重启后 `ensureSession` 用 `session/resume` 恢复已知会话。
- `stop()` 先发 `shutdown` 请求，2s 未退出则 SIGTERM，再 3s SIGKILL。
- 测试用 `test/support/fake-dsh-runtime.js`（bridge 负责人维护）实现同一协议的可控假 runtime。

## 5. 渠道配置（`channels.<id>`）

所有渠道支持：`enabled`（默认 false）、`accountId`（默认 `<id>`）、`allowFrom`（字符串数组，
形如 `"<senderId>"` 或 `"*"`）、`dmPolicy`（渠道级覆盖：open|allowlist|pairing）、
`groups: { enabled, requireMention, allowFrom }`、`webhookPath`（webhook 模式默认值如下）。

| channel | 模式 | 关键字段 | 默认 webhookPath |
| --- | --- | --- | --- |
| feishu | `ws`（默认） / `webhook` | `appId`, `appSecret`, `domain`('feishu'\|'lark'), `encryptKey`, `verificationToken` | `/webhook/feishu` |
| dingtalk | `stream`（默认） / `webhook` | `clientId`, `clientSecret`, `robotCode` | `/webhook/dingtalk` |
| wecom | `ws`（默认，智能机器人长连接） / `webhook` | `botId`, `secret`（ws）；`token`, `encodingAESKey`, `corpId`, `agentId`（webhook/自建应用） | `/webhook/wecom` |
| weixin | `ilink`（个人微信，腾讯官方 openclaw-weixin 协议） | `credentialsFile`（扫码登录后写入），`baseUrl`, `cdnBaseUrl`, `longPollTimeoutMs`, `reconnect` | —（长轮询，无 webhook） |

敏感值允许写成 `env:ENV_NAME`（运行时解析）或 `${ENV_NAME}`（配置加载时插值）。
**任何 adapter 不得把密钥写日志。**

## 6. 访问控制语义（core 实现，adapter 不重复实现）

- `access.dmPolicy`：
  - `open`：任何 DM 可用；
  - `allowlist`：`senderId` 必须在 `access.allowFrom` 或渠道级 `allowFrom` 中；
  - `pairing`（默认）：未授权 DM 收到一条配对提示（含 6 位配对码），
    运维执行 `dsh-im-manager pair <code>` 后加入 allowlist。
- 群聊：`access.groups.enabled=false` 时一律忽略群消息（静默，避免刷屏）；
  开启后 `allowFrom` 为空表示所有群，否则只允许列出的 `conversationId`；
  `requireMention=true` 时未 @ 机器人的消息忽略。
- allowFrom 匹配规则：`"*"` 全放行；否则精确匹配 `senderId`（DM）或 `conversationId`（群）。
- 渠道级 `allowFrom` 与全局取并集；渠道级 `groups` 覆盖全局 groups 对应字段。

## 7. 会话映射与命令

- 会话键：`<channel>:<accountId>:<conversationType>:<conversationId>[:<threadId>]`。
- **作用域**：一个 gateway 实例 = 一个工作区（`dsh.cwd`）；工作区内每个会话一条绑定。
  会话键不含 workspace（因为一实例一工作区），但持久化文件记录工作区指纹
  `{cwd, dshHome}`，跨工作区复用 stateDir 时丢弃旧绑定。
- 持久化：`<stateDir>/sessions.json`，格式
  `{ version: 2, workspace: { cwd, dshHome? }, sessions: { <key>: { sessionId, createdAt, lastUsedAt } } }`。
- 每个会话串行处理；不同会话并发（上限 `gateway.concurrency`，默认 4）。
- 聊天内命令（core 处理，大小写不敏感）：
  - `/new`：为该会话分配新 sessionId（旧 session 保留在 DSH 持久化中）；
  - `/status`：回复当前 sessionId、DSH bridge 状态、渠道健康；
  - `/help`：命令列表；
  - `/id`：回复当前会话键与发送者 id（用于配置 allowFrom）。
- 命令不计入 Agent 上下文。

## 8. 回复编排（core）

1. 收到 `InboundMessage` → 去重 → 访问控制 → 命令分发。
2. 取/建 sessionId → `bridge.ensureSession` → 注册本轮 waiter → `bridge.prompt`。
3. 期间：`session.status=running` 时对支持 typing 的渠道调用 `startTyping`；
   `session.event` 中 `assistant/message` 收集 `data.message.content` 的 text blocks；
   `turn/end` 时结束本轮（`reason.completed` 用最后一条非空 assistant 文本；
   其他 reason 发错误提示，`showErrorDetail` 控制是否带原因）。
4. 回复按 `reply.chunkChars` 分片；`reply.maxChunks`（默认 6，0 = 不限）为每轮最多发送片数，
   超出时发前 `maxChunks-1` 片 + 一条“其余 N 段已省略”提示。
5. 正常完成但无可见文本时，发送 `reply.emptyText`（默认 `（本轮没有文本输出）`）。
6. 一个 turn 超时（`dsh.turnTimeoutMs`）→ 发送超时提示，保留 session。

## 9. 日志与状态

- 日志：JSON lines 到 stderr；`log.child(scope)` 带 `scope` 字段。禁止打印密钥/token。
- `dsh-im-manager status`：读取 `<stateDir>/gateway.json`（运行时写入 pid、启动时间、
  各渠道状态）并尝试 `kill(pid,0)` 判断存活。
- 健康：channel adapter 的 `health()` 被 `/status` 和 status 命令使用。

## 10. 测试约定

- 只用 `node:test` + `node:assert/strict`，不引入测试框架。
- 每个 adapter 自带 `test/adapters/<id>/`：用本地伪造的 HTTP/WS 平台端点验证
  inbound 解析、去重 id、群 @ 判定、outbound 请求形状与鉴权、错误重试一次。
- bridge 用 `test/support/fake-dsh-runtime.js` 验证握手、prompt、事件、重启、shutdown。
- e2e：fake IM 平台 + fake DSH runtime + 真实 core/adapter，覆盖“收到消息→回复”闭环。

## 11. 明确不做（v1）

- Web 设置面板 / 扫码登录 UI。
- 个人微信走腾讯官方 openclaw-weixin / iLink 协议（`weixin` 渠道，扫码登录）；
  微信公众号与微信客服入口不提供（已移除，不维护）。
- 语音/视频转写、附件抽取（PDF/DOCX）。
- 流式编辑回复（先整段回复；adapter capabilities 预留）。
- 多账号并存（同一渠道一个账号实例；`accountId` 字段已预留）。
