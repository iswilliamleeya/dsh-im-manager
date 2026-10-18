# 飞书 / Lark 渠道接入指南

飞书（Lark）渠道通过企业自建应用的机器人能力接入。v1 支持两种运行模式：

| 模式 | 需要公网入口 | 适用场景 | 配置 |
| --- | --- | --- | --- |
| `ws`（默认，推荐） | 否 | 内网 / 个人电脑 / 没有 HTTPS 域名 | `mode: "ws"`，应用订阅方式选**长连接** |
| `webhook` | **是** | 已有 HTTPS 反代、需要事件回调统一入口 | `mode: "webhook"`，应用订阅方式选**将事件发送至开发者服务器** |

> 首次接入建议直接用 `ws`：免公网、免 TLS、断线自动重连，配置最少。

## 1. 在飞书开放平台创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)（Lark 国际版用 <https://open.larksuite.com/app>），
   创建**企业自建应用**。
2. 在「凭证与基础信息」拿到 **App ID**（形如 `cli_` + 16 位十六进制）和 **App Secret**。
3. 在「添加应用能力」中开启 **机器人**。
4. 在「权限管理」申请并开通以下权限（至少）：
   - `im:message`：获取与发送单聊、群组消息（发送回复必需）；
   - `im:message.p2p_msg:readonly`：读取用户发给机器人的单聊消息；
   - `im:message.group_at_msg:readonly`：获取群组中 @ 机器人的消息。
   如需回复群消息，还需保证机器人已开启「发送消息」相关权限（`im:message:send_as_bot` 一类）。
5. 在「事件与回调」→「事件订阅」添加事件 **`im.message.receive_v1`（接收消息）**。
6. 在「事件与回调」→「订阅方式」按模式二选一：
   - `ws` 模式：选择 **使用长连接接收事件/回调**；
   - `webhook` 模式：选择 **将事件发送至开发者服务器**，填写 `https://<公网域名>/webhook/feishu`。
7. 在「版本管理与发布」创建版本并发布，同时设置**可用范围**（只有范围内的用户能使用机器人）。
   发布前权限/事件都不生效，这是最常见的“机器人没反应”原因。

## 2. 配置

编辑网关配置（默认 `~/.dsh/im-manager/config.json`，或 `--config` 指定的文件）：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "mode": "ws",
      "appId": "env:FEISHU_APP_ID",
      "appSecret": "env:FEISHU_APP_SECRET",
      "domain": "feishu",
      "allowFrom": []
    }
  }
}
```

webhook 模式：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "mode": "webhook",
      "appId": "env:FEISHU_APP_ID",
      "appSecret": "env:FEISHU_APP_SECRET",
      "verificationToken": "env:FEISHU_VERIFICATION_TOKEN",
      "encryptKey": "env:FEISHU_ENCRYPT_KEY",
      "webhookPath": "/webhook/feishu"
    }
  },
  "gateway": {
    "http": { "enabled": true, "host": "127.0.0.1", "port": 8787, "publicBaseUrl": "https://bot.example.com" }
  }
}
```

敏感值不写明文，用 `env:NAME`（推荐）或 `${NAME}` 插值。adapter 本身不打印任何密钥或
`tenant_access_token`，网关日志对 `authorization` / `secret` 等字段做结构化脱敏。

### 2.1 字段说明

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用该渠道 |
| `mode` | `"ws"` \| `"webhook"` | `"ws"` | 运行模式；兼容别名 `connectionMode: "websocket"` |
| `appId` | string | — | 应用 App ID，`ws` 模式必须是 `cli_` + 16 位十六进制 |
| `appSecret` | string | — | 应用 App Secret |
| `domain` | `"feishu"` \| `"lark"` | `"feishu"` | 国内飞书 / 国际 Lark；也允许传自定义 base URL（仅测试用） |
| `encryptKey` | string | `""` | webhook 安全模式的 Encrypt Key；配置后 adapter 自动解密回调 |
| `verificationToken` | string | `""` | webhook 回调 Verification Token；配置后校验 token |
| `webhookPath` | string | `/webhook/feishu` | webhook 路由路径，必须以 `/` 开头 |
| `accountId` | string | `"feishu"` | 账号标识，参与会话键 |
| `allowFrom` / `groups.*` | — | — | 访问控制由 core 统一实现，语义见 [channels/index.md](index.md) |
| `botOpenId` | string | `""` | 可选：机器人自己的 `open_id`。不填时启动时自动查询，失败则按 `@_user_1` 约定判定 @ |
| `botName` | string | `""` | 可选：机器人显示名，用于 `post` 富文本里的 @ 判定/剥离 |
| `markdownAsCard` | boolean | `true` | Markdown 用卡片发送；`false` 时一律发纯文本（别名 `sendMarkdownAsCard`） |
| `replyInThread` | boolean | `false` | 目标带 `threadId` 时是否用 `reply_in_thread` 回复到话题中 |

### 2.2 通过 manager Web UI 扫码连接（v1.1）

如果使用 `dsh-im-manager manager` 的多工作区 Web UI，可以不走上面的手工建应用流程：

1. 新建工作区后，飞书渠道默认是 `enabled:false`；
2. 在飞书卡片点「启用」，弹窗有两个 tab：
   - **扫码创建/登录**（默认）：用飞书 App 扫码并按手机提示确认，走官方设备码应用注册；
   - **手动填写**：直接填 App ID / App Secret / Domain，等价于 `PUT config` 写入并启用；
3. 扫码确认成功后，manager 把 `appId`/`appSecret`/`domain` 写进工作区配置并置
   `enabled:true`（运行中的工作区会自动重启）；
4. **未确认就关闭弹窗（X / Esc / 点遮罩 / 取消）会取消本次连接，渠道保持关闭**；
   已启用的渠道再次点连接会返回 409，需要先停用。

说明：

- 扫码创建出的飞书应用**仍需在飞书开放平台补齐机器人/消息权限并发布版本**，manager 不代做权限申请；
- 弹窗里可随时「重新生成二维码」（过期/失败后）；
- 本文件上面的手工创建应用 + 配置字段的方式仍然完全可用，二者等价；
- API/状态机细节见 [../manager.md](../manager.md) §6。

## 3. `ws` 模式（推荐）

- 使用 `@larksuiteoapi/node-sdk` 的 `WSClient` + `EventDispatcher` 建立到飞书的出站长连接，
  事件 `im.message.receive_v1` 由飞书推送，**不需要公网 URL、不需要 TLS**。
- `start()` 在连接建立前就会返回（SDK 内部自动重连、指数退避）；连接状态通过 `health()` 暴露：
  `connected` / `connecting` / `degraded` / `disconnected`。
- 启动前检查：缺失 `appId` / `appSecret`、`appId` 格式不对、模式非法都会抛出清晰错误，
  网关会记录并以「渠道启动失败」告警（不会影响其他渠道）。
- 若日志提示 SDK 侧 `invalid appId`，先确认 App ID 是从凭据页复制的完整值。

## 4. `webhook` 模式

前置条件：`gateway.http.enabled=true`，并用 Caddy / Nginx 把 HTTPS 反代到
`http://127.0.0.1:<port><webhookPath>`（网关自身不做 TLS）。

处理流程（`src/adapters/feishu/webhook.js`）：

1. 读取并校验 JSON；
2. 若 body 含 `encrypt` 且配置了 `encryptKey`，用 `AES-256-CBC(SHA-256(encryptKey))` 解密；
   未配置 `encryptKey` 但收到密文则返回 400；
3. 配置了 `verificationToken` 时校验 `header.token` / `token`，不匹配返回 403；
4. URL 验证请求（`type: "url_verification"`）**同步**返回 `{"challenge": "..."}`；
5. 普通事件**先返回** `{"code":0,"msg":"success"}`，再在 `setImmediate` 中交给 core 处理。

> 飞书要求 3 秒内应答，所以第 5 步不能等 Agent 回复。测试里用「先应答、后 emit」的时序断言
> 覆盖了这一点（`test/adapters/feishu/webhook.test.js`）。

### 4.1 关于签名校验（取舍）

飞书在安全模式下还会发 `X-Lark-Signature` 头（`sha256(timestamp + nonce + encryptKey + body)`）。
v1 的 adapter **不强制校验签名**，只做「解密 + verificationToken」：
签名校验要求同时配置 `encryptKey`，且对 body 序列化方式敏感；而推荐部署是 `ws` 长连接或
HTTPS 反代。若你的安全要求更高，建议使用 `ws` 模式，或在反代层做来源限制。文档与实现保持一致，
后续若补签名校验会同步更新本节。

## 5. 群聊接入要求

1. 把机器人**拉进群**（群设置 → 群机器人 → 添加机器人）；
2. 机器人需要在群内有发言权限，且应用版本已发布、可用范围包含群成员；
3. 群消息默认**必须 @ 机器人**才会被处理（core 的 `access.groups.requireMention=true`）：
   - `@机器人` 判定基于 `message.mentions[]` 的 `id.open_id` 与机器人 `open_id` 比较；
   - 启动时会调用 `/open-apis/bot/v3/info` 自动获取机器人 `open_id`，拿不到时退化为
     Feishu 的 `@_user_1` 占位符约定（`botOpenId` / `botName` 可手动固定）；
   - 群聊里 @ 其他人不会被误判为 @ 机器人；
4. 需要在群里响应时，在配置里打开：

```json
{ "gateway": { "access": { "groups": { "enabled": true, "requireMention": true, "allowFrom": [] } } } }
```

`allowFrom` 为空表示允许所有群；否则填写群的 `conversationId`（`oc_...`，可用 `/id` 命令查看）。
只允许机器人被 @ 后响应，可避免群里刷屏。

## 6. 入站映射规则

| 飞书字段 | 网关字段 | 说明 |
| --- | --- | --- |
| `message.chat_id` | `conversationId` / `target.conversationId` | `oc_...` |
| `message.chat_type` `p2p` | `conversationType: "dm"` | 单聊恒 `mentioned=true` |
| `message.chat_type` `group` | `conversationType: "group"` | `mentioned` 由 mentions 判定 |
| `message.message_id` | `messageId` | 平台唯一 id；缺失时用 `event_id` 或内容 hash 生成**稳定** id |
| `sender.sender_id.open_id` | `sender.id` | 用于 `allowFrom` |
| `message.content`（text） | `text` | 去掉 `@_user_N` 占位符，@机器人被移除、@他人还原为 `@名字` |
| `message.content`（post） | `text` + 图片附件 | 富文本按行拍平，标题、链接文本保留 |
| `message.content`（image/file/audio/media/video） | `attachments` | 记录 `image_key` / `file_key` / 文件名，见 §7 |
| `message.thread_id` / `root_id` | `target.threadId` | 优先 `thread_id`，其次 `root_id` |
| `message.create_time` | `timestamp` | epoch ms |

忽略：`sender_type` 为 `app`/`bot` 的消息、机器人自己 `open_id` 的消息、非
`im.message.receive_v1` 事件、无法识别的消息类型（如 `share_chat`）、重复 `messageId`
（adapter 5 分钟窗口 + core 去重双重保护）。

## 7. 出站格式与限制

- **纯文本**（`format: "plain"`）：`msg_type=text`，`content={"text": "..."}`。
- **Markdown**（`format: "markdown"`，core 的 `reply.format=auto` 时默认）：用 `interactive`
  卡片 + `lark_md` 发送。取舍：飞书纯文本消息不渲染 Markdown，而 `post` 富文本需要严格的
  逐节点 JSON 结构；卡片是最小且可靠的 Markdown 载体。`lark_md` 支持粗体、删除线、链接、
  @ 和换行，但**不支持标题与代码块**（会以字面文本显示）。
- **降级**：卡片被飞书拒绝（或网络/HTTP 错误）时，自动用同一条文本以 `text` 消息重发
  （Markdown 标记按原文显示）；core 在 `send()` 抛错时还会再做一次纯文本重试。
- **回复位置**：`target.replyToMessageId` 存在时优先 `im/v1/messages/:message_id/reply`
  （入站映射会把原消息 id 带上）；reply 失败或没有该字段时改用
  `im/v1/messages` 向 `target.conversationId`（chat_id）发送。
- **鉴权**：由 SDK `Client` 自动获取并缓存 `tenant_access_token`，请求头
  `Authorization: Bearer <token>`；adapter 不接触、不记录 token。
- **不支持**（v1，`capabilities.media=false`）：出站图片/文件、流式编辑、typing 指示。
  入站附件只保留 metadata（`image_key`、`file_key`、文件名、大小），不下载到本地；
  core 不会把附件内容转给 Agent。

后续如需“Agent 发图”，可在 v2 增加 `im/v1/images` 上传 + `msg_type=image`，并打开 `media` 能力。

## 8. 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报 `missing appId` / `missing appSecret` | 配置未填或 `env:` 变量为空；检查 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| 启动报 `invalid appId ... expected "cli_" + 16 hex` | App ID 抄错（带了空格 / 用了旧版 id）；从「凭证与基础信息」重新复制 |
| `ws` 模式日志显示连接失败 / `code: 10003` | 应用没开启「长连接」订阅方式，或应用未发布、可用范围不含当前账号 |
| 私聊机器人无反应 | 权限未开通（`im:message.p2p_msg:readonly`）、版本未发布、或 core 的 `dmPolicy=pairing` 正在等待配对 |
| 群里 @ 机器人无反应 | 机器人不在群、群权限未开、`access.groups.enabled=false`、或 `requireMention` 判定失败（可配置 `botOpenId`） |
| 群里不 @ 也回复 | 把 `groups.requireMention` 设为 `true`（默认值），或检查 `access.groups.enabled` |
| webhook 报 `requires the gateway HTTP host` | `gateway.http.enabled=false`；webhook 模式必须开启 HTTP 宿主 |
| 飞书后台提示 URL 校验失败 | 公网地址不可达 / 反代没转发到 `webhookPath` / `verificationToken` 不一致（403） |
| webhook 返回 400 `encryptKey not configured` | 飞书后台开了 Encrypt Key，但配置里没填 `encryptKey`（或用了 `env:` 但变量为空） |
| webhook 返回 400 `decrypt failed` | `encryptKey` 填错；注意不是 Verification Token |
| 飞书后台提示 3 秒超时 | 反代超时或网关 HTTP 端口未通；本 adapter 会先应答再处理，通常不会触发 |
| 回复发送失败 / 报 `feishu API error code=...` | 机器人不在会话、无发言权限、消息超长（core 会分片）、被限频（单聊/群 5 QPS） |
| 收到重复回复 | 检查是否同时开了 `ws` 与 `webhook` 两种订阅方式（只保留一种） |

## 9. 本地验证与测试

```bash
# adapter 单元测试（本地假飞书 API，不访问外网）
node --test 'test/adapters/feishu/*.test.js'

# 配置检查（会报告缺失/非法字段）
dsh-im-manager doctor

# 启动
dsh-im-manager serve
```

测试覆盖：DM 文本、群 @ / 未 @ / @ 他人、图片与文件消息、富文本、机器人自身消息过滤、
messageId 稳定性与去重、thread/root、webhook challenge（明文与密文）、verificationToken
校验、3 秒内先应答后 emit、出站 reply/create 请求形状与 `Authorization` 鉴权、Markdown
卡片与降级、失败抛错。

## 10. 安全提示

- 只把 `appSecret` / `encryptKey` / `verificationToken` 放在环境变量或权限 600 的配置文件里；
- 网关不打印 token，但**反向代理访问日志**可能记录回调 body，注意脱敏；
- webhook 模式建议只暴露 `webhookPath`，并在反代层做 IP/频率限制；更推荐 `ws` 模式；
- 群聊建议保持 `requireMention=true` 并用 `groups.allowFrom` 限定允许的群。
