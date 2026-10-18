# 钉钉（DingTalk）渠道配置

本渠道把钉钉机器人消息转成网关统一的 `InboundMessage`，由 core 驱动 DSH Agent
后，通过每条用户消息自带的 `sessionWebhook` 回复。实现见
[`src/adapters/dingtalk/`](../../src/adapters/dingtalk/)，接口契约见
[contracts.md](../contracts.md) §2、§5。

## 1. 支持情况

| 能力 | 状态 |
| --- | --- |
| 模式 | `stream`（默认，推荐，无需公网） / `webhook`（HTTP 回调，需公网 HTTPS） |
| 入站文本 | ✅ `text`、`richText` |
| 入站媒体 | ✅ 识别 `picture`/`image`/`file`/`audio`/`video`，记录 `downloadCode`（v1 不下载） |
| 语音转写 | ✅ 使用钉钉返回的 `content.recognition` 文本 |
| 群聊 @ 判定 | ✅ `isInAtList` / `atUsers` |
| 出站 | ✅ markdown / text，经 `sessionWebhook` |
| 出站图片/文件 | ❌ v1 不支持（`media: false`） |
| 流式编辑 / typing | ❌ |

单聊和群聊都走同一套逻辑；群聊默认要求 @机器人（由 core 的 `groups.requireMention`
控制，adapter 负责正确上报 `mentioned`）。

## 2. 平台侧准备

1. 打开[钉钉开放平台](https://open.dingtalk.com/) → 创建**企业内部应用**，记下
   `Client ID`（AppKey）和 `Client Secret`（AppSecret）。
2. 应用 → **添加应用能力 → 机器人**，填写机器人名称/头像。
3. 选择**消息接收模式**：
   - **Stream 模式**（推荐）：不需要公网地址，由钉钉服务端主动推送，本机只需能出站访问
     `wss://api.dingtalk.com`。
   - **HTTP 回调**：需要一个公网可达的 HTTPS 地址（一般用 Caddy/Nginx 反向代理到
     `gateway.http.host:port`）。
4. 配置 **server 出口 IP / 权限**：至少授予"机器人接收消息"能力；`stream` 与
   `sessionWebhook` 回复不需要额外 OpenAPI 权限。
5. **发布应用**（应用版本管理与发布）并设置可用范围。未发布 / 未加入范围的用户收不到
   机器人消息。
6. 若使用 webhook 模式，在机器人安全设置中开启**加签**，使用同一个 Client Secret 校验。

> 本 adapter v1 只用 `sessionWebhook` 被动回复，不调用主动推送 OpenAPI，因此不需要
> 申请"机器人发送消息"相关的主动发送权限。

## 3. 配置示例

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "accountId": "dingtalk",
      "mode": "stream",
      "clientId": "env:DINGTALK_CLIENT_ID",
      "clientSecret": "env:DINGTALK_CLIENT_SECRET",
      "robotCode": "env:DINGTALK_ROBOT_CODE",
      "webhookPath": "/webhook/dingtalk",
      "verifySignature": true,
      "signatureSecret": "",
      "signatureMaxSkewMs": 3600000,
      "markdownTitle": "DSH",
      "requestTimeoutMs": 15000,
      "keepAlive": true,
      "quoteReply": false,
      "allowFrom": [],
      "groups": {
        "enabled": true,
        "requireMention": true,
        "allowFrom": []
      }
    }
  }
}
```

`env:DINGTALK_CLIENT_ID` / `${DINGTALK_CLIENT_ID}` 两种写法由 core 统一解析；adapter 也接受
未经插值的 `env:` 前缀（通过 `ctx.secret()`），便于测试或独立嵌入。**日志不会打印任何
密钥。**

## 4. 配置字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用该渠道 |
| `accountId` | `dingtalk` | 会话键中的账号标识 |
| `mode` | `stream` | `stream` 或 `webhook`；其他值按 `stream` 处理 |
| `clientId` | — | 应用 Client ID / AppKey；`stream` 模式必填 |
| `clientSecret` | — | 应用 Client Secret / AppSecret；`stream` 必填，webhook 校验签名必填 |
| `robotCode` | = `clientId` | 机器人编码，记入 `target.raw`，供后续主动推送扩展使用 |
| `botUserId` | — | 可选，机器人自身 userId；用于更严格地忽略机器人自己发的消息 |
| `webhookPath` | `/webhook/dingtalk` | 仅 webhook 模式；必须与公网反代路径一致 |
| `verifySignature` | `true` | webhook 模式是否校验加签；仅本地调试可设 `false` |
| `signatureSecret` | = `clientSecret` | 加签密钥；一般不用单独配置 |
| `signatureMaxSkewMs` | `3600000` | 时间戳允许偏差（±1 小时） |
| `markdownTitle` | `DSH` | markdown 标题兜底值；正常从正文首行自动提取 |
| `requestTimeoutMs` | `15000` | sessionWebhook POST 超时 |
| `keepAlive` | `false` | Stream SDK 心跳（长连接保活） |
| `quoteReply` | `false` | 群聊 markdown 引用回复（见 §7） |
| `allowFrom` / `groups` | — | 访问控制由 core 处理，语义见 [contracts.md](../contracts.md) §6 |

`groups.requireMention` 为 `true` 时，群消息未 @机器人会被 core 丢弃；adapter 会正确设置
`mentioned`，DM 则恒为 `true`。

## 5. 入站映射

| 钉钉字段 | 契约字段 | 说明 |
| --- | --- | --- |
| `msgId` | `messageId` | 平台消息 id；缺失时依次回退到 Stream `headers.messageId`、内容哈希 `dt_<sha256前24位>` |
| `conversationType` | `conversationType` | `"1"` → `dm`，`"2"` → `group` |
| `conversationId` | `conversationId` | 群聊用平台 `conversationId`；单聊用 `senderStaffId`（缺失时 `senderId`） |
| `senderStaffId` / `senderId` | `sender.id` | 优先 `senderStaffId` |
| `senderNick` | `sender.name` | — |
| `text.content` | `text` | 群聊且 `mentioned` 时去掉开头的 `@机器人` 片段 |
| `isInAtList` / `atUsers` | `mentioned` | 群聊任一为真即视为 @ 机器人 |
| `createAt` | `timestamp` | 毫秒时间戳（兼容秒级输入） |
| `sessionWebhook` 等 | `target.raw` | 回复必需，含过期时间 |

消息类型处理：

- `text`：取 `text.content`；
- `richText`：解析 `content.richText[]`，文本拼接，图片元素转附件；
- `picture`/`image`：附件 `{ kind: "image", mediaId: <downloadCode> }`；
- `file`：附件 `{ kind: "file", name: fileName, size: fileSize, mediaId: <downloadCode> }`；
- `audio`：附件 `audio` + 用 `content.recognition` 作为正文；
- `video`：附件 `video`。

`downloadCode` 不是可直接访问的 URL，v1 不下载媒体；core 会把附件信息以
`[附件 <kind>: <name>] <mediaId>` 的文字提示交给 Agent。后续要用图片/文件时，可用
`robotCode` + `downloadCode` 调钉钉 `robot/messageFiles/download` 换取临时 URL（roadmap）。

过滤规则：忽略机器人自己发的消息（`senderId` 命中 `chatbotUserId`/`clientId`/`robotCode`/
`botUserId`）、预置事件、无文本且无附件的消息；adapter 侧对同一 `messageId` 做 60 秒去重
（core 还有一层去重），平台重投只 ACK 不重复交付。

## 6. 出站（回复）

每条用户消息都带一个短期有效的 `sessionWebhook`（包含 access token），adapter 直接 POST：

```json
{ "msgtype": "markdown", "markdown": { "title": "标题", "text": "正文" } }
```

- core 给出 `format: "markdown"` 时发 markdown（标题取正文首行，去掉 `#`/`*` 等符号，
  兜底 `markdownTitle`）；否则发 `{ "msgtype": "text", "text": { "content": "..." } }`。
- 分片由 core 负责（`gateway.reply.chunkChars`），adapter 逐条发送。
- 附件里**有 URL** 时以 `📎 [名称](URL)` 追加到正文；本地路径/媒体 id 无法通过 webhook
  重发，会提示不支持。
- `sessionWebhook` 过期（`sessionWebhookExpiredTime` 已过）或缺失时，`send()` 抛出
  明确错误，core 会记录并尝试纯文本降级；降级仍失败则记录错误。**不会吞错。**
- 错误信息不会包含 webhook URL（其中含 access token）。

## 7. 引用回复（可选）

钉钉 `sessionWebhook` 官方只支持 markdown/text，不保证原生"引用回复"字段。adapter 提供
best-effort 开关：`quoteReply=true` 时，**群聊 + markdown + 有被引用消息 id/sender id**
会在请求体顶层附加 `referenceOpenMessageId` / `srcMsgSendOpenDingTalkId`（与钉钉 OpenAPI
群消息引用参数同名）。默认关闭，避免旧租户拒绝未知字段；如启用后发送失败，core 会降级为
纯文本（降级不走引用字段）。

## 8. Stream 模式

启动后 adapter 使用 npm 包 [`dingtalk-stream`](https://www.npmjs.com/package/dingtalk-stream)
的 `DWClient`：

```js
client.registerCallbackListener('/v1.0/im/bot/messages/get', handler);
```

SDK **不会自动 ACK** 回调：handler 同步调用
`client.socketCallBackResponse(headers.messageId, { success: true })` 应答，然后异步把
消息交给 core。这样即使 Agent 一轮要跑几分钟，钉钉也不会在 60 秒后重投（重投还有一层
`messageId` 去重兜底）。

要点：

- 只需能出站访问 `wss://api.dingtalk.com`，不用公网入口；
- 断线由 SDK 自动重连（`health()` 在未连上时返回 `connecting`）；
- 机器人只在被 @ 时收到群消息，私聊直接推送。

```bash
export DINGTALK_CLIENT_ID=...  DINGTALK_CLIENT_SECRET=...
dsh-im-manager doctor --config <workspace>/.dsh-im-manager/config.json
# 然后在 DSH「消息」里创建/启动该工作区的 Gateway
```

在钉钉里私聊机器人发一条消息，或在群里 @机器人 提问即可；`/status`、`/new`、`/id`
等命令由 core 处理。

## 9. Webhook 模式

需要 `gateway.http.enabled=true`，并把 `webhookPath`（默认 `/webhook/dingtalk`）暴露到
公网 HTTPS（建议前置 Caddy/Nginx）。adapter 注册 `POST <webhookPath>`：

1. 校验加签：`sign = base64(HMAC-SHA256(clientSecret, "${timestamp}\n${clientSecret}"))`，
   `timestamp` 为毫秒；支持 header `timestamp`/`sign`（也兼容从 query 或 JSON body 读取），
   超出 `signatureMaxSkewMs` 或签名不符返回 `401`。
2. 校验通过立即返回 `200 {"errcode":0,"errmsg":"ok"}`（先应答平台，再异步 `emit`）。
3. 回复仍使用回调 payload 里的 `sessionWebhook`。若该 payload 没有 `sessionWebhook`，
   `send()` 会报"当前会话没有可用的 sessionWebhook"——这是平台侧回调类型决定的，需要改用
   Stream 模式或扩展主动推送（v1 不做）。

本地自测签名与路由：

```bash
export DINGTALK_CLIENT_SECRET=你的ClientSecret
TIMESTAMP=$(node -e 'console.log(Date.now())')
SIGN=$(TIMESTAMP="$TIMESTAMP" node -e 'const c=require("node:crypto");console.log(c.createHmac("sha256",process.env.DINGTALK_CLIENT_SECRET).update(`${process.env.TIMESTAMP}\n${process.env.DINGTALK_CLIENT_SECRET}`).digest("base64"))')
curl -sS -X POST "http://127.0.0.1:8787/webhook/dingtalk" \
  -H "content-type: application/json" \
  -H "timestamp: $TIMESTAMP" -H "sign: $SIGN" \
  -d '{"msgId":"m1","conversationType":"1","senderStaffId":"u1","senderId":"u1","senderNick":"tester","msgtype":"text","text":{"content":"hello"},"createAt":'$TIMESTAMP'}'
# => {"errcode":0,"errmsg":"ok"}（无 sessionWebhook，后续回复会报错，属预期）
```

## 10. 测试

```bash
cd dsh-im-manager
# 全渠道 adapter 测试（本仓库 scripts 用 glob，Node 24 下直接传目录不会展开）
npm run test:adapters
# 只跑钉钉
node --test --test-reporter=spec 'test/adapters/dingtalk/*.test.js'
```

覆盖内容：入站映射（DM/群/@/richText/图片/文件/语音）、稳定 `messageId`、重复投递去重、
机器人自消息过滤、Stream ACK 在 emit 之前、真实本地 fake sessionWebhook 捕获出站请求形状、
过期/缺失 webhook 报错、加签正确/错误/过期、webhook 先应答后异步 emit。

adapter 的可注入 seam（e2e 也用这个）：

```js
import { createAdapter } from './src/adapters/dingtalk/index.js';
const adapter = createAdapter({ streamClientFactory, fetch, now });
await adapter.start({
  config, emit, log: silentLogger, signal, http, stateDir, secret: (name) => process.env[name],
});
```

- `streamClientFactory`：返回带 `registerCallbackListener`/`connect`/`disconnect`/
  `socketCallBackResponse` 的假客户端（见 `test/adapters/dingtalk/helpers.js`）。
- `fetch`：替换出站 POST（默认 `globalThis.fetch`）。
- `now`：固定时钟，便于测试 webhook 过期与签名窗口。

## 11. 常见错误

| 现象 / 日志 | 原因与处理 |
| --- | --- |
| `[dingtalk] invalid config: clientId ... required` | `env:DINGTALK_CLIENT_ID` 对应的环境变量没设置，或配置里还是空串 |
| `dingtalk-stream 未安装` | 在 `dsh-im-manager` 目录执行 `npm install` |
| Stream 启动后一直 `connecting` | 检查出站网络/代理（需访问 `wss://api.dingtalk.com`），确认应用已发布、机器人能力已开启 |
| `Connect failed` / 401 / `invalid clientId or clientSecret` | Client ID/Secret 填错，或复制时带了空格；重新在开放平台确认 |
| 私聊/群聊都收不到消息 | 应用未发布、可用范围不含该用户、机器人能力未启用、消息接收模式与 `mode` 不一致 |
| 群聊 @ 了也不回复 | `groups.enabled=false`（core 静默忽略）或 `groups.requireMention=true` 但未 @；用 `/id` 查 ids 配 `allowFrom` |
| 私聊收到"配对码"提示 | core 默认 `dmPolicy: "pairing"`，执行 `dsh-im-manager pair <code>` 或改用 allowlist |
| `DingTalk 回复失败：当前会话没有可用的 sessionWebhook` | 该会话没有可回复的 webhook（主动推送/无 webhook 的 webhook 回调）；等用户再发消息，或改用 Stream 模式 |
| `DingTalk sessionWebhook 已过期` | 回复时已超过 `sessionWebhookExpiredTime`（Agent 跑太久），等用户重新发消息；可缩短任务或调大 `dsh.turnTimeoutMs` |
| `DingTalk sessionWebhook 返回 HTTP 400/401/403` | webhook 过期/鉴权失败；错误里已提示，不会再自动重试该条 |
| `DingTalk sessionWebhook 返回错误 errcode=...` | 按 `errmsg` 排查（正文过长、markdown 格式、被限流等） |
| webhook 模式 401 `invalid signature` | 服务器时间偏差过大（±1h）、`clientSecret`/`signatureSecret` 不匹配、平台未开启加签 |
| 日志 `dingtalk duplicate message dropped` | 平台重投被去重，正常现象 |

## 12. v1 限制

- 不支持主动推送（没有会话时无法发送），只做被动回复；
- 不下载入站媒体，只记录 `downloadCode`；
- 出站不支持图片/文件上传，只支持 markdown/text 和远程 URL 链接；
- 不支持流式编辑、typing 指示、话题（thread）；
- 同一渠道只支持一个账号实例（`accountId` 字段已预留多账号）。
