# 企业微信（WeCom）渠道接入指南

企业微信渠道接入的是**企业内部机器人**，v1 支持两种运行模式：

| 模式 | 平台形态 | 需要公网入口 | 适用场景 | 关键凭据 |
| --- | --- | --- | --- | --- |
| `ws`（默认，推荐） | **智能机器人**长连接 | 否 | 内网 / 个人电脑 / 没有 HTTPS 域名；**群聊也只能用这个模式** | `botId` + `secret` |
| `webhook` | **自建应用**回调 | **是** | 已有 HTTPS 反代、需要统一 HTTP 入口的单聊应用 | `token` + `encodingAESKey` + `corpId` + `agentId` + `secret` |

> 两种模式的凭据来自企业微信后台**两个不同的产品**，不能混用：
> 智能机器人拿的是 BotID/Secret；自建应用拿的是 CorpID/AgentId/Secret/Token/EncodingAESKey。
>
> 首次接入建议直接用 `ws`：免公网、免 TLS、自动心跳与指数退避重连，配置最少。
> 群聊只有智能机器人（`ws`）能收消息；自建应用回调只覆盖单聊。

## 1. 创建智能机器人（`ws` 模式）

1. 用管理员账号打开 [企业微信管理后台](https://work.weixin.qq.com)，进入
   **应用管理 → 智能机器人**（不同版本菜单名可能略有差异），创建机器人。
2. 在机器人详情页拿到 **BotID** 与 **Secret**——这是长连接鉴权用的凭据。
3. 接收消息方式选择 **长连接**：不需要配置回调 URL、Token、EncodingAESKey。
4. 设置机器人的**可见范围**；只有范围内的人能和它对话。
5. 群聊场景：把机器人添加进目标群，并在群里 @ 它（平台只推送 @ 机器人的群消息）。

平台约束（adapter 已按此实现）：

- **一个机器人同一时间只能有一条长连接**；新连接建立后服务端会给旧连接推送
  `disconnected_event` 并断开旧连接。adapter 默认**不与被踢的连接抢线**（见 `reconnectOnKicked`），
  因此不要用两个网关实例同时启用同一个 bot。
- 收到消息回调后 24 小时内、每会话最多 30 条回复；主动推送每会话每自然日 10 条。
- 流式消息（`stream`）须在 6 分钟内 `finish=true`；adapter 每条回复直接以 `finish=true` 结束。
- 媒体下载 URL（图片/文件/视频）**5 分钟有效**，且带独立 `aeskey` 加密。

## 2. `ws` 模式配置

编辑网关配置（默认 `~/.dsh/im-manager/config.json`，或 `--config` 指定的文件）：

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "ws",
      "botId": "env:WECOM_BOT_ID",
      "secret": "env:WECOM_SECRET",
      "botName": "小助手",
      "allowFrom": []
    }
  }
}
```

```bash
export WECOM_BOT_ID='bot-xxxxxxxx'
export WECOM_SECRET='secret-xxxxxxxx'
dsh-im-manager doctor     # 检查配置
# 在 DSH「消息」里创建/启动该工作区的 Gateway；日志出现 ws authenticated 即成功
```

### 2.1 字段说明

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用该渠道 |
| `mode` | `"ws"` \| `"webhook"` | `"ws"` | 运行模式，非法值启动时报错 |
| `botId` | string | — | 智能机器人 BotID（`ws` 必填） |
| `secret` | string | — | 智能机器人 Secret（`ws` 必填） |
| `botName` | string | `""` | 机器人显示名。群聊里用于判定/剥离 `@机器人名`；不填时按「任意 `@xxx`」判定 |
| `wsUrl` | string | `wss://openws.work.weixin.qq.com` | 长连接地址，一般不用改（测试/代理可覆盖） |
| `heartbeatIntervalMs` | number | `30000` | `ping` 心跳间隔 |
| `maxMissedPong` | number | `2` | 连续多少次心跳无 ack 判定连接失效并重连 |
| `authTimeoutMs` | number | `15000` | 连接建立后等待订阅 ack 的超时 |
| `replyAckTimeoutMs` | number | `10000` | 回复帧等待平台回执的超时；超时 `send()` 抛错由 core 处理 |
| `reconnectInitialDelayMs` | number | `1000` | 重连初始退避 |
| `reconnectMaxDelayMs` | number | `30000` | 重连退避上限（指数退避 + jitter） |
| `reconnectOnKicked` | boolean | `false` | 被 `disconnected_event` 踢掉后是否重连。默认 false，避免多实例互踢 |
| `accountId` | string | `"wecom"` | 账号标识，参与会话键 |
| `allowFrom` / `groups.*` | — | — | 访问控制由 core 统一实现，语义见 [channels/index.md](index.md) |

敏感值不要写明文，用 `env:NAME`（推荐，运行时解析）或 `${NAME}`（加载时插值）。

## 3. `ws` 模式工作方式

实现文件：`src/adapters/wecom/{ws-client,ws-protocol,inbound}.js`。

1. 连接 `wss://openws.work.weixin.qq.com` 后立即发送
   `{"cmd":"aibot_subscribe","headers":{"req_id":"aibot_subscribe_..."},"body":{"bot_id":...,"secret":...}}`；
2. 平台回 `{"headers":{"req_id":"aibot_subscribe_..."},"errcode":0,"errmsg":"ok"}` 表示鉴权成功
   （ack 帧没有 `cmd`，靠 `req_id` 前缀区分订阅/心跳/回复回执）；
3. 每 `heartbeatIntervalMs` 发 `{"cmd":"ping","headers":{"req_id":"ping_..."}}`，连续
   `maxMissedPong` 次收不到 ack 就断开重连；
4. 断线后按 `reconnectInitialDelayMs × 2^n`（封顶 `reconnectMaxDelayMs`，带 jitter）重连；
5. 入站：`aibot_msg_callback`（消息）与 `aibot_event_callback`（事件，v1 忽略；除
   `disconnected_event` 外不做业务处理）；
6. 出站：用入站帧的 `headers.req_id` 原样回发
   `{"cmd":"aibot_respond_msg","headers":{"req_id":...},"body":{"msgtype":"stream","stream":{"id":...,"finish":true,"content":...}}}`，
   同一 `req_id` 的回复串行发送，并等待平台回执后才算发送成功；
7. 主动推送：仅当该会话此前给机器人发过消息（adapter 内存中的 activated 表）才允许，使用
   `aibot_send_msg` + `msgtype:"markdown"`。平台有每日额度，失败会抛错。

健康状态通过 `health()` 暴露：`connected`（已鉴权）/ `connecting`（建链或重连中）/
`disconnected`（已停止、被踢或重连耗尽）。

## 4. 创建自建应用（`webhook` 模式）

1. 企业微信管理后台 → **我的企业 → 企业信息**，复制**企业 ID**（`corpId`，形如 `ww...`）。
2. **应用管理 → 自建 → 创建应用**，填写名称与可见范围。
3. 应用详情页拿到 **AgentId** 与 **Secret**。
4. 应用详情 → **接收消息 → 设置 API 接收**：
   - URL：`https://<公网域名>/webhook/wecom`（与配置里的 `webhookPath` 一致）；
   - Token：自己生成，填进配置的 `token`；
   - EncodingAESKey：后台生成（43 位 Base64），填进配置的 `encodingAESKey`。
5. 应用详情 → **企业可信 IP**：把网关出网 IP（反向代理出口 IP）加进去，
   否则调用 `gettoken` / `message/send` 会报 `60020 not allow to access from your ip`。
6. 可用范围要包含使用者；修改后需要**重新保存/发布**才生效。
7. 网关侧：`gateway.http.enabled=true`，配置 `gateway.http.publicBaseUrl`，并用
   Caddy/Nginx 把 HTTPS 反代到 `http://127.0.0.1:<port>/webhook/wecom`。网关自身不做 TLS。

> 自建应用的回调只覆盖**单聊**（用户与应用会话）。群聊消息不属于自建应用回调，
> 需要群聊请改用 §1 的智能机器人 `ws` 模式。

## 5. `webhook` 模式配置与处理流程

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "webhook",
      "token": "env:WECOM_TOKEN",
      "encodingAESKey": "env:WECOM_ENCODING_AES_KEY",
      "corpId": "env:WECOM_CORP_ID",
      "agentId": "env:WECOM_AGENT_ID",
      "secret": "env:WECOM_SECRET",
      "botName": "小助手",
      "webhookPath": "/webhook/wecom",
      "allowFrom": []
    }
  },
  "gateway": {
    "http": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 8787,
      "publicBaseUrl": "https://bot.example.com"
    }
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `token` | string | — | 后台「设置 API 接收」里填的 Token（`webhook` 必填） |
| `encodingAESKey` | string | — | 43 位 Base64（解码后 32 字节）；错误会在启动时报配置错误 |
| `corpId` | string | — | 企业 ID；解密后会校验密文尾部的 receiveId 必须等于它 |
| `agentId` | string | — | 应用 AgentId，出站应用消息必填 |
| `secret` | string | — | 应用 Secret，用于换取 `access_token` |
| `botName` | string | `""` | 群/兼容 XML 场景下用于判定并剥离 `@机器人名` |
| `webhookPath` | string | `/webhook/wecom` | 回调路径，必须以 `/` 开头 |
| `apiBaseUrl` | string | `https://qyapi.weixin.qq.com` | 企业微信 API 基地址（测试/代理用） |
| `requestTimeoutMs` | number | `15000` | 调用 API 的超时 |

处理流程（`src/adapters/wecom/{crypto,webhook,api}.js`）：

- **GET 验证**：`msg_signature = sha1(sort(token, timestamp, nonce, echostr))`。签名通过后
  用 `EncodingAESKey` 解密 `echostr`（AES-256-CBC，IV=key 前 16 字节，PKCS#7 填充到 32 字节倍数），
  把明文原样返回 200；签名错 401，缺参数 400。
- **POST 回调**：签名对象是外层 XML 的 `<Encrypt>`；验签后解密，校验尾部 receiveId=corpId，
  **先返回 `success`**，再异步解析 XML（兼容 JSON）→ 归一化 → `emit` 给 core。
  企业微信对回调有超时重试，绝不能让 Agent 的耗时影响应答。
- **出站**：`cgi-bin/gettoken` 换取并缓存 `access_token`（提前 5 分钟过期）；`cgi-bin/message/send`
  发文本或 Markdown 应用消息。遇到 `40014/42001/42007/42009`（token 失效）自动刷新一次后重试；
  其余非 0 errcode 抛错，由 core 记录并尝试降级。
- **不做 passive reply**：v1 的契约要求「先快速应答平台、再异步 emit」，而 passive reply 需要
  等 Agent 生成完才写 HTTP 响应，两者冲突；因此统一走应用消息 API。日志中不打印 token/secret。

## 6. 入站映射规则

| 企业微信字段 | 网关字段 | 说明 |
| --- | --- | --- |
| `chatid`（ws 群）/ `ChatId`（兼容 XML） | `conversationId` `target.conversationId` | 群聊 id |
| 单聊（`chattype=single` / 自建应用回调） | `conversationId = senderId` | 单聊用 userid 作会话 id |
| `chattype=group` / `ChatType=group` | `conversationType: "group"` | 否则 `dm`，DM 恒 `mentioned=true` |
| `from.userid` / `FromUserName` / `From.UserId` | `sender.id` | 用于 `allowFrom` |
| `msgid` / `MsgId` | `messageId` | 缺失时用 from+时间+内容 hash 生成**稳定** id（`gen_...`） |
| `text.content` / `Content` | `text` | 已剥离 `@机器人名`；@其他人的内容保留 |
| `voice.content` / `Recognition` | `text` | 语音优先用平台转写文本 |
| `image` / `PicUrl`+`MediaId` | `attachments[]` | ws：`url` + `aesKey`（5 分钟有效）；应用回调：`mediaId` + `picUrl` |
| `file` / `video` | `attachments[]` | 保留 `url`（ws，含 `aesKey`）或 `mediaId` |
| `create_time` / `CreateTime` | `timestamp` | 秒 → epoch ms |
| `headers.req_id`（ws） | `target.raw.reqId` | 出站回复必须复用它 |

- 群聊 `mentioned` 判定顺序：回调自带 mention 列表非空 → 文本包含 `@<botName>`（配置了
  `botName`）→ 文本包含任意 `@xxx`（未配置 `botName`）。判定失败时 core 在
  `groups.requireMention=true` 下丢弃消息。
- 忽略：事件回调（`subscribe` / `enter_chat` / 模板卡片事件等，v1）、`msgtype=event|stream`
  的回调、找不到发送者的消息。
- 附件只保留 metadata，不下载到本地；ws 的媒体 URL 5 分钟后失效，Agent 侧如果耗时过长可能拿不到图。

## 7. 出站格式与限制

- **文本 / Markdown**：`ws` 模式统一走 `aibot_respond_msg` 的 `stream.content`（企业微信按
  Markdown 渲染），单条内容超过 20480 字节会按 UTF-8 安全截断；`webhook` 模式按
  `message.format` 选择 `msgtype: "text"` 或 `"markdown"`。
- **分片**：core 按 `gateway.reply.chunkChars` 分片逐条调用 `send()`；adapter 每条回复独立发送
  并以 `finish=true` 结束，不做同一条消息的原地流式编辑（`capabilities.streaming=false`）。
- **不支持**（v1）：出站图片/文件（`capabilities.media=false`）、typing 指示
  （`capabilities.typing=false`）。入站附件只作为 URL/metadata 提供给 Agent。
- **主动推送**（ws）：仅对「此前给机器人发过消息」的会话生效，走 `aibot_send_msg` + markdown；
  平台限制每会话每日 10 条。`webhook` 模式群聊出站会直接抛错，提示改用 `ws`。
- **发送失败**：`send()` 不吞错；回执 errcode 非 0、回执超时、连接断开都会抛错，由 core
  记录并按契约做一次降级重试。

## 8. 群聊接入要求

1. 群聊只能用 `ws`（智能机器人）模式；把机器人添加进群；
2. 打开 core 的群访问控制，例如：

```json
{ "gateway": { "access": { "groups": { "enabled": true, "requireMention": true, "allowFrom": [] } } } }
```

`allowFrom` 为空表示所有群；否则填写群的 `conversationId`（可用 `/id` 命令查看）。
3. 群消息默认必须 @ 机器人：建议配置 `botName`（与群里的机器人显示名一致），@ 判定更准确；
   未配置时按「任意 `@xxx`」判定并只剥离行首的 @。
4. 群里 @ 其他人不会被当作 @ 机器人（配置了 `botName` 时尤其准确）。

## 9. 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报 `botId is required` / `secret is required` | `ws` 模式凭据未填，或 `env:` 变量为空；注意智能机器人用的是 BotID/Secret，不是自建应用凭据 |
| 日志 `ws authentication failed: errcode=...` | BotID/Secret 错、机器人被删除，或另一个实例正占用连接 |
| 日志反复 `ws disconnected_event` / 刚连上就被踢 | 同一 bot 在别处（另一网关实例/另一台机器）也开了长连接；平台只允许一条 |
| 日志 `ws heartbeat lost ... reconnecting` | 网络中断或心跳被拦截；检查出网/代理，等待指数退避自动重连 |
| 私聊机器人没反应（ws） | 机器人可见范围不含该用户、core `dmPolicy=pairing` 正在等配对、或消息被去重 |
| 群里 @ 机器人没反应 | 机器人不在群、`groups.enabled=false`、`botName` 配错导致 `mentioned=false`、或 `groups.allowFrom` 不含该群 |
| 收到消息但回复报 `errcode=...` | 24 小时/30 条回复额度用尽、消息超长、连接已断开重连中；查看 gateway 日志 errcode |
| webhook 后台提示「URL 验证失败」 | 公网地址不可达、反代没转发到 `webhookPath`、`token` 不一致（401）、`EncodingAESKey`/`corpId` 错（400） |
| webhook POST 返回 401 `unauthorized` | 签名校验失败：`token` 与后台不一致，或中间层改写了 query/body |
| webhook POST 返回 400 `decrypt failed` | `encodingAESKey` 抄错（注意不是 Token），或 `corpId` 与该企业不符（receiveId 校验失败） |
| `gettoken` 报 `60020 not allow to access from your ip` | 出网 IP 未加入「企业可信 IP」 |
| `gettoken` 报 `40001` / `40013` | `secret` / `corpId` 错（Secret 是否被重置） |
| `message/send` 报 `81013` / `invalid user` | 用户不在应用可见范围，或 `agentId` 错 |
| `message/send` 报 `42001 access_token expired` | adapter 会自动刷新一次；仍失败时检查系统时间与可信 IP |
| 收到重复回复 | 同一 bot 开了多条长连接，或 webhook/长连接两种接入方式同时启用 |
| 自建应用收不到群消息 | 自建应用回调本来就不含群聊；群聊请用智能机器人 `ws` 模式 |

## 10. 本地验证与测试

```bash
# adapter 测试（本地假 WS 服务端 / 本地 HTTP 服务端 / 自造密钥，不访问真实企业微信）
node --test 'test/adapters/wecom/*.test.js'

# 配置检查（逐渠道报告缺失/非法字段，不会打印密钥值）
dsh-im-manager doctor

# 启动：在 DSH「消息」里创建/启动该工作区的 Gateway
```

测试覆盖：sha1 签名固定向量、AES 加解密 roundtrip（含 receiveId 校验失败、错误密钥）、
媒体 `aeskey` 解密、GET URL 验证、POST 验签/解密/快速应答、入站 dm/group/@ 判定/附件映射、
messageId 稳定性、ws 订阅握手/心跳/回复帧 `req_id` 复用/断线重连/被踢不重连、
出站 `message/send` 请求形状与 token 缓存/刷新、密钥不出现在日志中。

## 11. 安全提示

- `secret` / `token` / `encodingAESKey` 一律用 `env:` 或 `${}` 引用，不要提交到仓库；
  配置文件建议 `chmod 600`。
- 网关与 adapter 不打印密钥、token 或带 `corpsecret` 的 URL；但**反向代理访问日志**可能记录
  回调 body，注意脱敏。
- `webhook` 模式只暴露 `webhookPath`，在反代层做 HTTPS、IP/频率限制；能用 `ws` 就优先 `ws`。
- 群聊保持 `groups.requireMention=true` 并用 `groups.allowFrom` 限定允许的群，避免刷屏与误触发。
- 同一个智能机器人不要在多个网关实例上同时启用长连接（互踢 + 重复回复）。
