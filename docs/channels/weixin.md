# 个人微信（Weixin / iLink）渠道配置

> 状态：v1，模式 `ilink`（腾讯官方 openclaw-weixin / iLink HTTP 协议，扫码登录 + 长轮询）。
> 实现文件：`src/adapters/weixin/`。契约：`docs/contracts.md` §2（Adapter）、§5（渠道配置）。
>
> 这是**个人微信**渠道（`channels.weixin`）。微信公众号 / 微信客服入口不在本项目范围内（已移除）。

个人微信渠道让 Agent 通过一个微信机器人账号与用户**单聊**：用户用手机微信扫码把机器人登录到本网关，
之后所有发给该机器人的私聊消息由网关转成统一的 `InboundMessage` 交给 DSH Agent，Agent 的回复通过
iLink `sendmessage` 发回。

不需要公网 URL、不需要 HTTPS 证书、不需要 webhook。网关以
“机器人客户端”的身份主动向腾讯 iLink 服务端长轮询，适合个人电脑 / 内网 / 家庭服务器部署。

```
手机微信 ──扫码登录──▶ 腾讯 iLink 后端 ◀──getupdates 长轮询── 本网关 adapter
                                   ◀──sendmessage 发送回复──
```

---

## 1. 原理与限制（先看这节）

### 1.1 登录：手机微信扫一扫

1. 运行 `dsh-im-manager weixin login`（或 `serve` 常驻时随时运行）；
2. CLI 请求 `get_bot_qrcode` 拿到二维码内容，用 `qrcode-terminal` 在终端渲染，同时打印备用链接；
3. 用手机微信扫描 → 手机端显示一个数字验证码 → 在终端输入（`need_verifycode`）；
4. 手机端确认后，服务端返回 `bot_token` + `ilink_bot_id` + `baseurl`，adapter **立即写入凭据文件**
   （`0600`，原子写）；
5. `serve` 进程每 3 秒检查一次凭据文件；文件出现/更新后**自动启动长轮询**，无需重启网关。

二维码有时效（约 5 分钟，`loginTimeoutMs`）；过期会自动刷新，最多刷新 3 次。扫码后服务端可能要求切换
IDC 线路（`scaned_but_redirect`）——adapter 只接受 `*.weixin.qq.com` 官方域名或配置里最初的主机，其他
跳转一律中止登录（防止 token 被导向攻击者域名）。

### 1.2 收消息：`getupdates` 长轮询

`POST /ilink/bot/getupdates` 是服务端长轮询：没有新消息时连接会被挂起，直到有消息或服务端超时
（`longpolling_timeout_ms`，默认约 35s）。客户端侧超时属于正常控制流，直接重发下一轮。游标
（`get_updates_buf`）持久化在 `cursor.json`，网关重启后从上次位置继续；游标在**消息成功交给 core 之后**
才提交，失败会重放本轮（core 用 `messageId` 去重）。每轮消息在 emit 之前会先下载/解密其中的媒体
（见 §1.6）。

### 1.3 发消息：`sendmessage`

回复必须携带入站消息的 `context_token`（adapter 按发送者持久化在 `context-tokens.json`）。**出站**
媒体 v1 仍不支持（`capabilities.media=false`，只发文本）；**入站**图片/文件/视频/语音会先下载、AES 解密
并落盘，再作为附件路径交给 Agent（见 §1.6）。

### 1.4 能力与限制（v1）

| 能力 | 支持 | 说明 |
| --- | --- | --- |
| 文本 | ✅ | 纯文本，支持换行 |
| markdown | ❌ | `capabilities.markdown=false`，core 自动降级；adapter 也会再降级一次 |
| typing（“正在输入”） | ✅ | `getconfig` 取 `typing_ticket` + `sendtyping`，按用户缓存 10 分钟；**best-effort**，失败静默 |
| 出站图片/文件 | ❌ | v1 只发文本。`send()` 遇到附件记 warn 并忽略 |
| 入站图片/文件/视频/语音 | ✅ | 下载 + AES-128-ECB 解密 + 落盘到 `<stateDir>/media/`，回填 `path/mimeType/name/size`（见 §1.6）；失败退回 URL-only |
| 语音转写 | ✅ | `voice_item.text` 是微信转写文本，作为消息 `text` 传给 Agent |
| 群聊 | ❌ 不支持 | 官方 iLink 接口目前以**单聊**为主；adapter 把所有消息按 `conversationType='dm'`、`mentioned=true` 处理。`groups` 配置对本渠道无效 |
| 多账号 | ❌ | 一个 `channels.weixin` 对应一个机器人账号（`accountId` 仅用于会话键） |
| 流式输出 | ❌ | `streaming=false`，整段回复 |
| webhook / HTTP 路由 | ❌ | 不占用 HTTP 端口，`ctx.http` 不使用 |

> **单聊限制的原因**：个人微信 iLink 协议当前只稳定提供 1:1 会话的收发；即使服务端消息带 `group_id`，
> 本 adapter 也不会把它当群聊处理，避免回复路由错误。请把机器人当作“私人助理”使用。

### 1.5 消息 id 与去重

`messageId = wx-<message_id>`；平台偶尔缺失 `message_id` 时用稳定 FNV-1a 哈希兜底（同样输入始终得到
同样 id），所以网关重启/重放不会重复驱动 Agent。`message_type=2`（机器人自己的消息）一律丢弃，防止回显
死循环。

### 1.6 入站媒体：下载、解密与落盘

入站 `image_item` / `file_item` / `video_item` / `voice_item` 在消息交给 core **之前**由 adapter 处理：

1. **解析 CDN 地址**：优先 `media.full_url`；否则
   `<cdnBaseUrl>/download?encrypted_query_param=<encodeURIComponent(media.encrypt_query_param)>`。
2. **解析 AES key**（AES-128-ECB + PKCS#7，`node:crypto`）：
   - 图片：`image_item.aeskey`（32 位 hex）优先，其次 `media.aes_key`；
   - 文件 / 视频 / 语音：`media.aes_key`；
   - `media.aes_key` 既可能是「16 字节 raw 的 base64」，也可能是「32 字符 hex 字符串的 base64」
     （腾讯出站编码），两种都会归一化成 16 字节 key；
   - 图片**没有 key** 时按协议当作明文保存；文件/视频/语音没有 key 时只保留 URL、不落盘。
3. **落盘**：`<stateDir>/media/<messageId>-<index>.<ext>`（目录 `0700`、文件 `0600`、tmp+rename 原子写）：
   - 图片按 magic 识别 jpeg / png / gif / webp / bmp / heic；
   - 文件优先用 `file_item.file_name` 的扩展名和 MIME；没有扩展名时按内容嗅探，兜底 `.bin`；
   - 视频默认 `.mp4`；语音默认 `.silk`（也识别 amr / mp3 / wav / ogg / m4a；v1 不做 SILK→WAV 转码）；
   - 文件名做了路径穿越 / 控制字符清洗，不会写出 `media/` 目录。
4. **回填 Attachment**：`path`、`mimeType`、`name`、`size`；同时保留 `url`、`mediaId` 便于排查和下游
   自行解密。文件附件的 `name` 是原始文件名；图片/视频/语音是 `image-1.jpg` 这类稳定名。

网关（core）会用 `attachment.path`：图片读成 base64 image block 交给 Agent，文件复制进工作区并把本地
路径给 Agent。因此 `path/mimeType/name/size` 都是可直接使用的可靠值。

**失败不影响消息**：单条媒体下载 404 / 超时 / 超过上限 / 解密失败 / 格式无法识别时，只记一条脱敏
`warn`，附件退回 URL-only（不填 `path`），消息照常 emit。单条消息默认最多下载 8 个媒体
（`media.maxItemsPerMessage`）、单个媒体默认上限 25 MiB（`media.maxBytes`，按下载到的密文字节计）、
下载超时 30s（`media.timeoutMs`）；只处理真实用户消息。文件会持续累积在 `media/`，需要时由运维清理。

---

## 2. CLI 用法

命令都在 `dsh-im-manager` 项目根目录执行（或使用全局安装的 `dsh-im-manager`）。

### 2.1 扫码登录

```bash
dsh-im-manager weixin login
```

输出示例：

```
正在获取微信登录二维码…
<终端二维码>
请使用微信扫描下方二维码（或在微信内打开链接）：
https://weixin.qq.com/x/xxxxx
状态：wait
已扫码，请在手机微信上确认登录。
请输入手机微信显示的数字验证码：123456
已提交验证码，继续等待确认…
登录成功：xxxxx@im.bot（微信用户 xxxx@im.wechat）
凭据已写入；运行中的 Gateway 会在数秒内自动开始收发消息。
```

- 需要 `channels.weixin.enabled=true` 才会被 Gateway 启动；`enabled=false` 时登录仍会成功，但不会收发。
- 二维码内容只交给 CLI 渲染（adapter 不 import `qrcode-terminal`，也不打印 token）。
- 扫码后如果手机端要 **数字验证码**，在终端输入；连续输错会被服务端短暂封禁
  （`verify_code_blocked`），adapter 会刷新二维码让你重试。
- 若该微信此前已绑定本网关，服务端返回 `binded_redirect`：**保留本地凭据**，命令按成功处理。

### 2.2 查看登录状态

```bash
dsh-im-manager weixin status
```

打印凭据文件路径、`ilinkBotId`、扫码用户 id、API base、保存时间（**不打印 token**）。
未登录时退出码 1。

### 2.3 退出登录（删除凭据）

```bash
dsh-im-manager weixin logout
```

删除凭据文件；常驻网关会在数秒内停止长轮询并进入“未登录”状态。网关进程不会退出。

### 2.4 `serve` 常驻时扫码

`serve` 运行中也可以随时执行 `weixin login`。adapter 每 3 秒轮询凭据文件的 `mtime:size`，一旦发现
变化就热重载：

- 首次登录 → 启动长轮询；
- 重新登录（token 变化）→ 用新 token 重启长轮询，旧游标作废；
- 删除凭据 → 停止长轮询，health 变为 `disconnected`（未登录）。

---

### 2.5 通过 DSH「消息」页扫码连接

在 DSH 侧栏「消息」的工作区详情里，微信渠道也支持扫码：

1. 新建工作区后，微信渠道默认是 `enabled:false`；
2. 微信卡片点「启用」→ 弹窗**只显示二维码**（没有手动模式）；
3. 用手机微信扫码并在手机上确认；确认成功后：
   - 凭据仍由 `runWeixinLogin` 写到
     `<gateway.stateDir>/channels/weixin/credentials.json`（`0600`，配置里不出现 token）；
   - manager 把 `channels.weixin.enabled` 置为 `true`，运行中的工作区自动重启；
4. **未确认就关闭弹窗（X / Esc / 点遮罩 / 取消）会取消连接，渠道保持关闭**；
   已启用时再连接会返回 409，需先停用；
5. 二维码过期/失败时可在弹窗里「重新生成二维码」。

CLI 方式（§2.1 `weixin login`）仍然保留，二者等价；API/状态机见
[../manager.md](../manager.md) §6。

## 3. 配置

```jsonc
{
  "channels": {
    "weixin": {
      "enabled": true,
      "accountId": "weixin",
      "mode": "ilink",
      "baseUrl": "https://ilinkai.weixin.qq.com",
      "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
      "credentialsFile": "",
      "requestTimeoutMs": 15000,
      "longPollTimeoutMs": 35000,
      "reconnect": { "enabled": true, "baseDelayMs": 2000, "maxDelayMs": 30000 },
      "typing": true,
      "botAgent": "dsh-im-manager",
      "media": { "download": true, "maxBytes": 26214400, "timeoutMs": 30000, "maxItemsPerMessage": 8 },
      "allowFrom": [],
      "groups": {}
    }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启动该渠道 |
| `accountId` | string | `weixin` | 会话键里的账号标识 |
| `mode` | string | `ilink` | **只支持 `ilink`**；其他值启动时报错 |
| `baseUrl` | string | `https://ilinkai.weixin.qq.com` | iLink API 基址，**必须 https**；QR redirect/confirmed 返回的 `baseurl` 只接受官方 `*.weixin.qq.com` 域或与此处相同的主机 |
| `cdnBaseUrl` | string | `https://novac2c.cdn.weixin.qq.com/c2c` | 入站媒体 URL 拼接用（`media.full_url` 优先） |
| `credentialsFile` | string | `""` | 凭据文件路径；空 = `<stateDir>/credentials.json`。相对路径相对于渠道 stateDir，支持 `~` |
| `requestTimeoutMs` | number | `15000` | 普通请求超时（sendmessage 等） |
| `longPollTimeoutMs` | number | `35000` | `getupdates` 初始长轮询超时；服务端可在响应里动态调整 |
| `reconnect.enabled` | boolean | `true` | 网络错误是否指数退避重试 |
| `reconnect.baseDelayMs` | number | `2000` | 首次重试延迟 |
| `reconnect.maxDelayMs` | number | `30000` | 退避上限 |
| `typing` | boolean | `true` | 是否发送“正在输入” |
| `media.download` | boolean | `true` | 是否下载/解密入站媒体；`false` 时保持 URL-only |
| `media.maxBytes` | number | `26214400` | 单个入站媒体大小上限（字节，按下载到的密文计） |
| `media.timeoutMs` | number | `30000` | 单个入站媒体下载超时 |
| `media.maxItemsPerMessage` | number | `8` | 单条消息最多下载的媒体数量 |
| `botAgent` | string | `dsh-im-manager` | `base_info.bot_agent`（可观测标识，不参与鉴权） |
| `allowFrom` | string[] | `[]` | 允许的发送者 id（`wxid...@im.wechat`）；`"*"` 全放行，与全局 allowFrom 取并集 |
| `groups` | object | `{}` | 仅保持配置结构一致；个人微信 v1 不处理群聊 |

入站媒体也接受扁平写法：`mediaDownload`、`mediaMaxBytes`、`mediaDownloadTimeoutMs`（与 `media.*`
等价，`media.*` 优先）。

测试/CLI 可选字段（一般不用配）：`credentialsCheckIntervalMs`（凭据轮询间隔，默认 3000）、
`loginTimeoutMs`（扫码登录总时长，默认 300000）、`routeTag`（`SKRouteTag` 路由标签）、`botType`
（默认 `3`）。

> 凭据**不写在配置里**：不要手写 `token`。token 只存在于 `credentials.json`。

### 3.1 访问控制

与其它渠道一致（`docs/contracts.md` §6）：默认 `pairing` 策略，陌生用户会收到配对码，
`dsh-im-manager pair <code>` 之后才能驱动 Agent。个人使用时也可以：

```jsonc
"allowFrom": ["wxid_xxx@im.wechat"]   // 或 ["*"] 全放行（不推荐）
```

发送者 id 可用聊天内 `/id` 命令查看，或看日志里 `weixin inbound message` 行的 `from`。

---

## 4. 凭据与状态文件

默认 stateDir：`<gateway.stateDir>/channels/weixin/`（默认 `~/.dsh-im-manager/channels/weixin/`）。

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `credentials.json` | `{version:1, token, ilinkBotId, userId?, baseUrl, savedAt}` — **含 token** | `0600` |
| `cursor.json` | `getupdates` 游标 + 绑定的 `ilinkBotId` | `0600` |
| `context-tokens.json` | 按发送者 id 缓存 `context_token`（回复必需） | `0600`（含会话凭据） |
| `media/` | 下载并解密后的入站媒体（`<messageId>-<index>.<ext>`，图片/文件/视频/语音） | 目录 `0700`，文件 `0600` |

写入方式：**临时文件 + rename 原子替换**，避免断电/崩溃留下半截 JSON；目录按 `0700` 创建。

- 换账号/重新登录会更新 token；`cursor.json` 里记录了 `ilinkBotId`，与当前凭据不一致时自动从空游标
  重新开始（避免拿旧账号的游标去轮询新账号）。
- `context-tokens.json` 最多保留 500 个发送者（按最近使用淘汰）。
- 直接删除 `credentials.json` 等价于 `weixin logout`（`serve` 会自动停轮询）。

> 迁移到另一台机器时，只需拷贝 `credentials.json`（保持 `0600`）；cursor/context-tokens 可丢弃。

---

## 5. 断线重连

- 网络错误、5xx、响应解析失败：指数退避重试，`baseDelayMs × 2^(n-1)`，上限 `maxDelayMs`；期间 health = `reconnecting`（`/status` 可见）。
- 长轮询客户端超时（约 35s 没消息）：**不是错误**，立刻发下一轮。
- 服务端返回的 `longpolling_timeout_ms` 会动态用于下一轮（限制在 1s–120s）。
- 收到 `ctx.signal` abort（网关关闭）：立即中止在途请求、发送 best-effort `notifystop` 后退出。
- 重连失败不会退出网关进程；只有 `-14` 会让当前账号进入“需要重新登录”状态。

---

## 6. `-14`：token 失效，重新登录

服务端在 `ret` 或 `errcode` 返回 `-14` 表示 **bot token 已失效 / 会话过期**（改密码、长时间离线、
服务端清理等都可能触发）。

adapter 的处理：

1. 立即停止长轮询（不再重试，避免无意义请求）；
2. health 变为 `disconnected`，detail 包含 `-14` 和“运行 `dsh-im-manager weixin login` 重新扫码”；
3. **不删除凭据文件**、**不退出网关进程**；
4. 此时 `send()` 会抛出清晰错误（不含 token）。

恢复步骤：

```bash
dsh-im-manager weixin login     # 重新扫码，覆盖凭据文件
# serve 常驻的话，3 秒内自动恢复长轮询；否则重启 serve
dsh-im-manager weixin status    # 确认已登录
```

`/status` 或 `dsh-im-manager status` 里能看到类似：

```
weixin  disconnected  微信登录已失效（-14），运行 dsh-im-manager weixin login 重新扫码
```

---

## 7. 常见错误与排查

| 现象 / 日志 | 原因 | 处理 |
| --- | --- | --- |
| `未登录，运行 dsh-im-manager weixin login` | 没有 `credentials.json`，或文件损坏/无法解析 | 运行登录命令；确认文件 JSON 完整、权限 `0600` |
| `weixin mode must be 'ilink'` | 配置里 `mode` 写成了 `mp`/`webhook` 等 | 改成 `ilink`（个人微信没有 webhook 模式） |
| `weixin base URL must use https` | `baseUrl` 用了 `http://` | 改成 `https://ilinkai.weixin.qq.com` |
| `base URL host is not trusted` | 二维码 redirect/服务器 `baseurl` 指向非官方域名，或把 `baseUrl` 指向了自定义域名而服务端要求换域 | 用默认 `baseUrl`；自定义反向代理需保证返回主机与配置一致 |
| `微信接口 ... 返回错误 ret=...` | 服务端业务错误（参数/会话/风控） | 看 `errmsg`；`-14` 走重新登录流程 |
| `微信接口 ... HTTP 5xx` | iLink 服务端或中间网络异常 | 通常自动重连；持续出现看网络/代理 |
| `二维码已过期，正在刷新` / `登录超时` | 没在有效期内扫码确认 | 重新运行 `weixin login`，注意终端里二维码要显示完整 |
| `验证码错误次数过多` | 手机端数字验证码连续输错 | 稍等再登录；adapter 会刷新二维码 |
| 手机微信扫码后提示“已绑定” | 该微信已绑定本网关（`binded_redirect`） | 凭据仍有效，直接 `weixin status` 确认；无需重复登录 |
| 日志 `weixin inbound ignored (bot echo...)` | 收到机器人自己的消息（`message_type=2`） | 正常，防回显；无需处理 |
| 日志 `weixin inbound media download failed; keeping URL only` | CDN 404/网络错误/超时/超过大小上限 | 消息仍会送达，附件只有 URL；检查网络或调大 `media.maxBytes` / `media.timeoutMs` |
| 日志 `weixin inbound media decrypt failed; keeping URL only` | AES key 错误或媒体损坏 | 附件退回 URL-only；可让对方重发，或调大日志级别排查 |
| 日志 `weixin inbound message has too many media items` | 单条消息媒体数超过 `media.maxItemsPerMessage` | 只下载前 N 个，其余保留 URL；必要时调大该值 |
| 日志 `weixin outbound attachments are not supported` | Agent 想发图片/文件 | v1 只支持文本；改用文字或让 Agent 给链接 |
| `send` 报“长轮询尚未就绪” | 刚登录、monitor 还在启动 | 等 1–2 秒重试；若持续，看 health 与日志 |

### 7.1 自检清单

```bash
dsh-im-manager doctor                    # 配置/依赖/登录状态检查
dsh-im-manager weixin status             # 凭据与 API base
dsh-im-manager status                    # 运行中网关的渠道 health（含 ilinkBotId / -14）
# 日志（JSON lines）里搜 weixin：
#   "weixin adapter started" / "weixin long-poll connected" / "weixin inbound message"
```

---

## 8. 安全说明

1. **token 永不落日志**：所有错误信息、日志行、health detail 都经过脱敏；adapter 不打印请求头、
   不把 token 放进异常消息。凭据只在 `credentials.json` 里出现一次。
2. **凭据文件权限** `0600`、目录 `0700`；原子写避免半截文件。不要把凭据提交到 git（`state/` 已在
   `.gitignore`）。
3. **base URL 白名单**：QR redirect / confirmed `baseurl` 只接受官方 `*.weixin.qq.com` 域或配置里最初
   的主机，防止恶意/异常响应把 token 发到第三方域名。
4. **context_token 视同会话凭据**：只存本地 state 目录，不放进 `InboundMessage.raw`，也不会出现在日志里。
5. **二维码本身是登录凭据**：不要把终端二维码截图/链接发给别人；登录完成后旧二维码即失效。
6. **最小权限**：不需要公网 IP、不需要开放入站端口；建议机器人只用于自己/可信联系人，配合
   `access.dmPolicy=pairing` 或 `allowFrom` 白名单。
7. **登出即撤销本地凭据**：`weixin logout` 删除文件后本机不再能收发；服务端会话会在 token 过期后失效。
   怀疑泄露时：重新登录（会换 token）并将旧设备/进程停掉。
8. **媒体下载与日志**：只允许 `http(s)` 的 CDN 地址；媒体下载失败日志里 URL（含
   `encrypted_query_param`）和 AES key 一律脱敏，不会写入日志。解密后的文件落在本机 `media/`（`0600`），
   其中可能含敏感内容，按本地文件权限管理。

---

## 9. 实现结构（开发者）

```
src/adapters/weixin/
  index.js        Adapter：生命周期、凭据热重载、send/typing、health
  protocol.js     端点/headers/UIN/版本编码/base_info/baseUrl 白名单/脱敏
  config.js       channels.weixin 归一化与校验（mode=ilink）
  client.js       iLink HTTP 客户端（超时、长轮询、-14 → StaleTokenError）
  credentials.js  凭据读写（0600、原子写、脱敏）
  login.js        runWeixinLogin：二维码状态机 + 验证码 + redirect
  inbound.js      纯映射：iLink 消息 → InboundMessage
  outbound.js     sendmessage 载荷（markdown 降级）
  media.js        入站媒体：CDN 下载 + AES-128-ECB 解密 + MIME 嗅探 + 落盘
  monitor.js      getupdates 循环：cursor/context_token 持久化、退避、-14
  typing.js       getconfig/sendtyping（best-effort、ticket 缓存）
  storage.js      cursor.json / context-tokens.json 原子 JSON 存储
```

测试：`test/adapters/weixin/*.test.js`（node:test；iLink 侧注入 fake transport/fetch，媒体侧使用本地
`node:http` fake CDN，不连真实微信）。

```bash
cd dsh-im-manager
node --test --test-reporter=spec 'test/adapters/weixin/*.test.js'
```

关键契约点：

- 未登录 `start()` **不抛错**（health=disconnected + 登录提示），因此 `serve` 可以先起、后扫码；
- `stop()` 幂等：abort 长轮询、`notifystop`、清定时器；
- `send()` 失败抛清晰错误且不含 token；
- `-14` 只停下当前账号的轮询并标记未登录，**不退出网关进程**。
