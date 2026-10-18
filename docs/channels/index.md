# 渠道总览

dsh-im-manager v1 支持四个渠道：飞书、钉钉、企业微信、微信（个人）。
每个渠道一个账号实例，`channels.<id>` 下的配置结构一致，只有平台特有字段不同。

## 1. 一眼选型

| 渠道 | 推荐模式 | 需要公网 URL | 适合场景 |
| --- | --- | --- | --- |
| 飞书 / Lark | `ws` 长连接 | 否 | 企业内部机器人，推荐默认 |
| 钉钉 | `stream` 长连接 | 否 | 企业内部机器人，推荐默认 |
| 企业微信 | `ws` 智能机器人长连接 | 否 | 企业内部，推荐默认；也有自建应用 webhook |
| 微信（个人） | `ilink` 长轮询 | 否 | 个人微信号，扫码登录、v1 仅单聊；腾讯官方 openclaw-weixin / iLink 协议 |

长连接 / Stream / 长轮询模式都不需要公网入口，是个人或内网部署的首选；webhook 模式需要把
HTTP 端口暴露给平台，请先读 [security.md](../security.md) §5。

> **微信只保留个人微信**：`weixin` 走腾讯官方 `openclaw-weixin`（iLink HTTP 协议）扫码登录，
> 不要 appId/secret、不要公网。微信公众号（`wechat`）和微信客服入口已从本项目移除，
> 旧配置里的 `channels.wechat` 会被视为未知渠道报错，直接删除即可。

## 2. 公共配置

所有渠道都支持以下字段（默认值见 [configuration.md](../configuration.md)）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否启用，默认 `false` |
| `accountId` | string | 账号标识，默认等于渠道 id；用于会话键 |
| `allowFrom` | string[] | 该渠道的发送者/会话白名单，`"*"` 全放行 |
| `groups.enabled` | boolean | 是否处理群消息，默认 `false` |
| `groups.requireMention` | boolean | 群里是否必须 @机器人，默认 `true` |
| `groups.allowFrom` | string[] | 允许的群 `conversationId`，空数组表示所有群 |
| `webhookPath` | string | webhook 模式下的 HTTP 路径（`weixin` 无 webhook，不使用） |
| `mode` | string | 平台运行模式，默认见下表 |

渠道级 `allowFrom` 与全局 `access.allowFrom` 取并集；渠道级 `groups` 覆盖全局 `groups` 的对应字段。

## 3. 平台特有字段

| 渠道 | 模式 | 关键字段 | 默认 webhookPath | 详细文档 |
| --- | --- | --- | --- | --- |
| 飞书 | `ws`（默认）/ `webhook` | `appId`, `appSecret`, `domain`(`feishu`\|`lark`), `encryptKey`, `verificationToken` | `/webhook/feishu` | [feishu.md](feishu.md) |
| 钉钉 | `stream`（默认）/ `webhook` | `clientId`, `clientSecret`, `robotCode` | `/webhook/dingtalk` | [dingtalk.md](dingtalk.md) |
| 企业微信 | `ws`（默认，智能机器人）/ `webhook`（自建应用） | ws：`botId`, `secret`；webhook：`token`, `encodingAESKey`, `corpId`, `agentId` | `/webhook/wecom` | [wecom.md](wecom.md) |
| 微信（个人） | `ilink` | `credentialsFile`（扫码后生成）, `baseUrl`, `cdnBaseUrl`, `longPollTimeoutMs`, `reconnect`, `typing`, `botAgent` | —（无 webhook） | [weixin.md](weixin.md) |

## 4. 密钥与凭据写法

敏感值支持两种写法：

- `"env:FEISHU_APP_SECRET"`：运行时从环境变量解析，推荐；
- `"${FEISHU_APP_SECRET}"`：配置加载时插值，适合从模板生成配置。

两者都找不到时，启用该渠道会在启动/doctor 阶段报配置错误。示例见
[config.example.json](../../config/config.example.json) 与 [configuration.md](../configuration.md)。

`weixin` 例外：它不用 appId/secret，而是在终端执行扫码登录，凭据自动写入
`<gateway.stateDir>/channels/weixin/credentials.json`（`0600`，可用 `credentialsFile` 改路径）。
凭据等价于登录态，不要提交、不要外传；`weixin logout` 删除凭据。

## 5. 最小接入步骤（以飞书为例）

1. 在飞书开放平台创建企业自建应用，开启机器人能力，拿到 `appId` / `appSecret`；
2. 配置 `channels.feishu.enabled=true`、`mode=ws` 与密钥（用 `env:` 占位）；
3. `dsh-im-manager doctor` 检查配置与依赖；
4. 在 DSH「消息」里创建/启动该工作区的 Gateway，日志出现渠道连接成功；
5. 在飞书里私聊机器人发 `/id`，把返回的发送者 id 填进 `access.allowFrom`（或关闭 pairing）。

### 微信（个人）最短路径

1. 配置 `channels.weixin.enabled=true`（其余用默认值即可，无需公网）；
2. `dsh-im-manager weixin login`，用微信扫描终端二维码；
3. 凭据写入后，已在运行的 Gateway 会自动使用新凭据（或在 DSH「消息」里启动 Gateway）；
4. `dsh-im-manager weixin status` 查看登录状态；掉线/`-14` 时重新 login。

其他渠道的权限申请、事件订阅、加解密配置见各自文档。
