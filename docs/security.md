# 安全

> 一句话：**IM 入口 = 远程调用 Agent 的通道**。Agent 能做什么，取决于 DSH 的权限配置；
> 网关的责任是保证「谁可以触发」以及「密钥不泄漏」。

## 1. 信任模型

- gateway 以运行它的本机用户权限执行；DSH runtime 继承同一权限。
- 能给你发消息的人 ≈ 能对你的机器/仓库发起 Agent 请求的人。
- 因此默认策略是**只服务已授权用户**：DM 走配对（pairing），群聊默认关闭。
- 不要把 gateways 直接暴露在公网裸奔：webhook 模式无 TLS，见 §5。

## 2. DM 配对（pairing）

`access.dmPolicy`（默认 `pairing`）决定陌生 DM 怎么处理：

| 值 | 行为 |
| --- | --- |
| `pairing` | 未授权发送者收到一条配对提示（含 6 位配对码），Agent 不会收到消息 |
| `allowlist` | 只有 `access.allowFrom` / 渠道 `allowFrom` 中的发送者可用，其他人静默 |
| `open` | 任何人可用（仅建议在封闭环境/测试号使用） |

配对是**工作区级操作**：配对码属于该工作区实例的 `stateDir`，批准后只放行该实例的 IM 入口。
一个工作区 = 一个网关实例 = 一个 `pairing.json`。

配对流程：

1. 对方在 IM 里给机器人发任意消息；
2. 收到类似「配对码 123456」的提示；
3. 工作区 owner 在本机（该工作区目录下）批准，任选一种：
   - **CLI（推荐）**：`cd <workspace> && dsh-im-manager pair 123456`
     （工作区内的 `.dsh-im-manager/config.json` 会被自动发现；也可 `--config <path>` 指定）
   - **DSH 对话内**：让 Agent 调用 `im_gateway_pair` 工具批准（`im_gateway_status` 会列出待配对码）；
     只应在 owner 明确要求时使用，**不要批准陌生人发来的码**；
   - **预先授权**：`dsh-im-manager allow <channel>:<senderId>`，或配置
     `access.allowFrom` / `channels.<id>.allowFrom`。
4. 配对码加入 allowlist（持久化在 `<stateDir>/pairing.json` 的 `approved` 列表），
   之后的 DM 正常进 Agent。常驻网关会按文件 mtime 自动重载，**不需要重启**。

配对码有效期由 `gateway.access.pairingTtlSec` 控制（默认 600 秒）；过期后重发一条消息
会重新生成。同一发送者已有未过期配对码时不会重复发送提示。

> 注意：配对是把陌生人加入 allowlist 的**唯一交互入口**，不要把配对码转发到群里。
> 矩阵：多个工作区就有多份 `pairing.json`；批准前先确认当前目录/`--config` 指向的是哪个工作区
> （`pair` 会先打印「工作区：…」）。跨工作区批准无效。

## 3. allowlist 与群策略

### 3.1 allowFrom

- 全局 `access.allowFrom` 与渠道级 `channels.<id>.allowFrom` **取并集**。
- `"*"` 表示全放行。
- 否则精确匹配：DM 匹配 `senderId`；群聊匹配 `conversationId`（不是群成员 id）。
- 群聊里想「只允许某些人」，当前只能通过 `groups.allowFrom` 按**群**限制，
  不能按群成员白名单；需要更强隔离时，让 bot 只存在于专用群。

### 3.2 群聊

- `groups.enabled` 默认 `false`：群消息一律静默忽略。
- 打开后 `groups.allowFrom` 为空表示所有群；否则只服务列出的 `conversationId`。
- `groups.requireMention` 默认 `true`：群里必须 @机器人 才处理；adapter 的 `mentioned`
  判定失败时 core 按未提及丢弃。
- 渠道级 `groups` 覆盖全局 `groups` 的对应字段。

### 3.3 查自己的 id

在聊天里发 `/id`，会回复当前会话键与发送者 id，用来填写 allowFrom（命令本身受访问控制约束）。

## 4. 密钥管理

- 所有平台密钥（`appSecret`、`clientSecret`、`token`、`encodingAESKey`、`secret` 等）
  推荐写成 `env:NAME`（运行时从环境变量解析），或 `${NAME}`（配置加载时插值）。
  配置文件本身不应出现明文密钥。
- 环境变量来源：DSH 宿主启动环境 / shell 配置 / `.env`；
  不要把密钥写进 shell 历史、README、issue。
- 配置文件建议 `chmod 600`；`stateDir` 同样是敏感目录（含会话映射、运行状态）。
- adapter 与 core **不得把密钥/token 写入日志**；bridge stderr 中的平台 SDK 日志也要脱敏。
- 密钥轮换：更新环境变量后重启 gateway；长连接模式会断开重连。

## 5. Webhook 暴露面

- webhook / 自建应用回调模式需要平台能访问 gateway 的 HTTP 端口。v1 **不做 TLS**，
  生产环境请前置 Caddy/Nginx 反向代理并配置 HTTPS，或优先使用长连接 / Stream 模式。
- 各平台特征：
  - 飞书 webhook：`verificationToken` 校验 + 可选 `encryptKey` 解密；
  - 钉钉 webhook：签名校验（timestamp/sign HMAC-SHA256，以 adapter 文档为准）；
  - 企业微信自建应用：`token` + `encodingAESKey` 的 SHA1 签名与 AES 解密；

- 务必配置各平台文档要求的 token/密钥，不要用空值或示例值上线。
- 请求体上限 2 MiB（core HTTP 宿主），超过直接拒绝。
- 建议：只暴露必要路径；用反向代理限制来源 IP（各平台出口 IP 可在平台文档查到）；
  不要把 gateway 端口整体暴露为公网服务。
- 路由冲突在启动时报错；未知路径返回 404。

## 6. 日志脱敏

- 日志为 JSON lines 写到 stderr；`log.child(scope)` 带 `scope` 字段。
- 禁止输出：token、secret、encodingAESKey、完整 webhook 签名、Authorization 头。
- logger 会对名为 `token` / `secret` / `appSecret` / `encodingAESKey` / `authorization`
  等字段做结构性脱敏（替换为 `***`），`Bearer ...` 字符串也会被替换；但**不要把密钥拼进
  普通 message 文本**，脱敏只覆盖结构化字段和 bearer 前缀。
- 需要排障时可临时把 `gateway.log.level` 调到 `debug`，
  但 debug 日志同样不得包含密钥；排障后记得调回。
- 共享日志时先检查是否包含用户 open_id / userid / MsgId；这些属于业务标识，不是密钥，
  但对外分享前建议脱敏。

## 7. 运行权限建议

- 用专用低权限用户运行 gateway；只授予它需要访问的仓库/目录。
- DSH runtime 的工具权限在 DSH 侧配置（如 shell 命令白名单/审批），gateway 不代替它做权限控制。
- 在公开群/多人环境启用前，先用 DM + 测试号验证访问控制与命令行为。

## 8. 已知限制

- 不做个人微信非官方协议（无扫码登录、无 Web 管理面板）。
- 单渠道单账号；多账号需拆多个 gateway 实例（配置不同 `stateDir`）。
- 不做附件内容抽取；附件只以 URL/路径形式提示给 Agent。
