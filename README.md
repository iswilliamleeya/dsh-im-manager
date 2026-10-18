# dsh-im-manager

> 2026-10-18：项目从 `dsh-im-gateway` 更名为 `dsh-im-manager`；npm 包名、CLI 二进制、
> 配置/状态目录（`.dsh-im-manager`、`~/.dsh-im-manager`）一并改名。

把 **飞书 / 钉钉 / 企业微信 / 微信（个人）** 接进 DeepSeek Harness 的 IM 网关。
一条 IM 消息 → DSH Agent 一轮回答 → 按平台限制分片发回。

```text
IM 平台 ──adapter──▶ core（去重/访问控制/会话/编排）──bridge──▶ DSH SDK runtime
   ▲                                                              │
   └──────────────────── 回复（分片）◀── turn/end ◀── assistant/message
```

## 安装

### 作为 DSH profile bundle（推荐）

```bash
# 从 GitHub 安装到指定 profile（示例：desktop）
dsh plugin --profile desktop add github:iswilliamleeya/dsh-im-manager

# 或从本地 checkout / tarball
dsh plugin --profile desktop add /absolute/path/to/dsh-im-manager
dsh plugin --profile desktop add ./dsh-im-manager-0.2.0.tgz
```

- 安装后 bundle 默认启用，宿主启动时加载 host 插件（manager 模式）和 `消息` 侧栏页面；
- 可在 DSH 的「插件 → 已安装」里查看/开关/卸载；
- 首次安装若 pnpm 提示 `protobufjs` 构建脚本被忽略，按插件页提示允许构建并重试即可
  （来自飞书 SDK 的传递依赖，仅影响首次安装）。

### 手动安装（开发/离线）

```bash
bash install/activate.sh              # 直接写 desktop profile（manager 模式）
bash install/activate.sh --remove     # 卸载
bash install/verify-plugin.sh         # 隔离 profile 验证
```

### 打包

```bash
npm pack                             # 生成 dsh-im-manager-<version>.tgz
```

## 1. 定位

如果你熟悉 [OpenClaw](https://github.com/BytePioneer-AI/openclaw-china) 的
`gateway + channel plugins` 思路：本项目只实现 **gateway 和 channel 这一半**，
Agent 那一半交给 DSH：

| | OpenClaw | dsh-im-manager |
| --- | --- | --- |
| Agent runtime | 自带 | DSH SDK runtime（`dsh --profile sdk`，stdio JSON-RPC） |
| Channel | 插件 | `src/adapters/<id>/`，四个内置渠道（飞书/钉钉/企微/个人微信） |
| 会话/工具/权限 | 自带 | 复用 DSH（会话持久化、工具、审批） |
| 运行形态 | 独立进程 | DSH profile bundle（宿主插件） |
| 管理界面 | 有 | DSH 侧栏「消息」（原生 React）；CLI 仅诊断 |

好处是：不重复实现 Agent loop，换模型/改工具权限都在 DSH 侧完成；gateway 只关心
消息怎么进来、谁可以用、回复怎么出去。`src/bridge/` 是唯一与 DSH 通信的边界。

**生效范围：绑定单位是工作区，不是单个会话。** 一个 Gateway 实例 = 一个工作区
（`dsh.cwd` + `dsh.home`）= 一个 DSH runtime = 一套渠道账号；工作区内每个 IM 会话
（渠道/账号/聊天/话题）各自一个 DSH session，`/new` 只轮换该会话。多工作区就多实例
（各自 config/stateDir/HTTP 端口），由 DSH 侧栏按需创建/启动。`sessions.json` 记录工作区指纹，
stateDir 被另一工作区误用时会丢弃旧绑定并告警。详见 [docs/architecture.md §4.1](docs/architecture.md#41-生效范围绑定单位是工作区会话是工作区内的对话)。

## 2. 能力矩阵

| 能力 | 飞书 | 钉钉 | 企业微信 | 微信（个人） |
| --- | --- | --- | --- | --- |
| 文本收发 | ✓ | ✓ | ✓ | ✓ |
| Markdown（不支持时自动降级纯文本） | ✓ | ✓ | ✓ | —（纯文本） |
| 图片入站 | ✓ | ✓ | ✓ | ✓（下载+解密；视觉模型可见） |
| 文件入站 | ✓ | ✓ | ✓ | ✓（下载+解密，给 Agent 本地路径） |
| 群聊 | ✓ | ✓ | ✓ | —（官方 iLink 接口 v1 仅单聊） |
| 长连接（无需公网） | ✓ WS | ✓ Stream | ✓ WS | — |
| 长轮询（无需公网） | — | — | — | ✓ iLink |
| Webhook 模式 | ✓ | ✓ | ✓ | — |
| 扫码登录（免 appId/secret） | — | — | — | ✓ |
| 话题 / 回复串（threads） | ✓ | — | — | — |
| 「正在输入」 | — | — | — | ✓ |
| 回复分片（`reply.chunkChars`） | ✓ | ✓ | ✓ | ✓ |

> 「正在输入」是契约保留能力；v1 只有微信（个人）adapter 实现了 `startTyping`（best-effort），
> 其余四个 adapter 未实现、不显示。微信（个人）的群聊/媒体能力受官方 iLink 接口限制。

具体模式、字段与平台侧配置见 [docs/channels/index.md](docs/channels/index.md)。

## 3. 快速开始

前置：

- Node.js **>= 22.19**（推荐 24）；
- 一个可用的 DSH Desktop / Web 安装；
- 各平台的应用凭证（见下方各渠道入口）。

```bash
# 安装到 desktop profile（从 GitHub，或本地路径/tarball）
dsh plugin --profile desktop add github:iswilliamleeya/dsh-im-manager

# 开发模式：直接写 profile（不经过 pnpm）
bash install/activate.sh
```

重启 DSH 后：

1. 打开左侧栏 **「消息」**；
2. 在「DSH 工作区」里选择一个工作区 → 「创建 Gateway」；
3. 在渠道行里扫码/填配置启用飞书、钉钉、企微或个人微信；
4. 需要自动恢复时打开「自动启动」。

不再需要手动 `init` / `serve`。诊断可用 `dsh-im-manager doctor`（见 §6）。

## 4. 聊天内命令

在任意已授权的会话里发送（大小写不敏感，命令不进入 Agent 上下文）：

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令列表 |
| `/new` | 为该会话开启新会话（旧 session 保留在 DSH 中） |
| `/status` | 网关状态、DSH bridge 状态、渠道健康、当前 sessionId |
| `/sessions` | 列出本工作区的 IM 会话 → DSH session 映射（含当前会话标记） |
| `/id` | 当前会话键与发送者 id（用于配置 allowFrom） |
| `/stop` | v1 不支持中止进行中的一轮，会回复提示 |

## 5. 安全默认值

- 私聊默认 **pairing**：陌生人只会收到 6 位配对码，运维执行
  `dsh-im-manager pair <code>` 后才可用；
- **群聊默认关闭**；开启后默认必须 @ 机器人才处理；
- HTTP 宿主默认只监听 `127.0.0.1:8787`，webhook 模式建议前置 HTTPS 反向代理；
- 密钥推荐 `env:VAR` 插值，不写进配置文件；日志对敏感字段做结构性脱敏；
- 微信（个人）凭据文件默认 `<gateway.stateDir>/channels/weixin/credentials.json`（`0600`），
  等价于登录态，不要提交或外传；
- 配置细节与威胁模型见 [docs/security.md](docs/security.md)。

### 工作区内配对（安装后怎么用）

配对是工作区级操作：未授权用户发消息会收到 6 位配对码，owner 在该工作区里批准一次即可。
工作区配置由 DSH 侧栏「消息」创建 Gateway 时生成（`<workspace>/.dsh-im-manager/config.json`），
也可以在终端对已有工作区配置执行 `pair` / `list`（在 workspace 目录内自动发现配置）：

```bash
cd <workspace>
dsh-im-manager pair 123456           # 自动发现当前工作区配置，批准后立即生效
dsh-im-manager list                  # 查看该工作区的 allowlist / 待配对
```

如果网关是以 DSH 插件方式挂在宿主里，也可以在 DSH 对话中让 Agent 调用
`im_gateway_status`（列出待配对码）和 `im_gateway_pair` / `im_gateway_allow` 完成批准；
只有工作区 owner 明确要求时才应批准。多个工作区各自一份配置和 `pairing.json`，
在哪个工作区目录执行 `pair` 就批准哪个实例。

## 6. 诊断命令（可选）

日常管理在 DSH 侧栏「消息」里完成；CLI 只保留诊断/终端操作：

```bash
dsh-im-manager doctor [--config PATH]      # 体检，非 0 退出码表示有 error
dsh-im-manager status [--config PATH]      # 读 stateDir/gateway.json 并检查 pid
dsh-im-manager channels [--config PATH]    # 列出启用的渠道
dsh-im-manager sessions [--config PATH]    # 列出 IM 会话 → DSH session 映射
dsh-im-manager list [--config PATH]        # 允许列表 / 待配对
dsh-im-manager pair <code>                 # 批准配对码
dsh-im-manager allow <channel>:<senderId>  # 直接加白
dsh-im-manager revoke <channel>:<senderId> # 移出白名单
dsh-im-manager weixin login|status|logout  # 个人微信扫码登录 / 查看 / 退出
dsh-im-manager version
```

不再提供 `serve` / `manager` / `init`：单独运行 gateway 或 manager 的旧路径已移除，
运行入口统一为 DSH profile bundle（下一节）。

## 7. 作为 DSH profile bundle 安装

```bash
# 从 GitHub 安装到指定 profile（示例：desktop）
dsh plugin --profile desktop add github:iswilliamleeya/dsh-im-manager

# 或本地 checkout / tarball
dsh plugin --profile desktop add /absolute/path/to/dsh-im-manager
dsh plugin --profile desktop add ./dsh-im-manager-0.2.0.tgz
```

- 包声明 `dsh.bundle`，安装后自动挂载 host 插件（manager 模式）和 `消息` 侧栏页面；
- DSH「插件 → 已安装插件」里可见/启停/卸载；
- 首次安装若 pnpm 提示 `protobufjs` 构建脚本被忽略，按插件页提示允许并重试；
- 开发模式也可以 `bash install/activate.sh` 直接写 desktop profile（不经过 pnpm）；
- manager 的 HTTP API 仍监听 `127.0.0.1:8788`（仅 loopback），但**不再提供 Web UI 页面**：
  `GET /` 返回服务信息，管理界面就是 DSH 侧栏「消息」；
- 多工作区由 DSH 侧栏发现当前 profile 的 workspace，按需创建/启动 Gateway；每个工作区独立
  gateway、独立 DSH runtime、独立配置与 stateDir。

## 8. DSH 原生页面（D-v2）

客户端半边（`lib/client.js` + `dsh.client`）注册左侧栏 **「消息」**（在「插件」和「自动化任务」之间），
只保留侧栏入口。页面是原生 React 实现，不嵌入 iframe，也不依赖固定 8788 端口：

- 数据/操作走宿主 handler 注册的同源 RPC `/im-manager`（owner-only 门禁）；
- 界面风格对齐 DSH「插件」页（primitives、`--dsw-alias-*` token、列表/详情两级导航）；
- **工作区发现**：列表来自 `ctx.workspaceRegistry`，没有 Gateway 的工作区显示「未创建 Gateway」，
  可在详情里「创建 Gateway / 创建并启动」；不属于当前 profile 的 manager 条目单独显示；
- 支持工作区启停/重启/移除、渠道扫码/配置/停用、配对批准/allowlist、日志、自动启动；
- **IM 会话同步**：activity revision 变化时刷新 DSH 会话列表；宿主用
  `workspaceRegistry.resolveByPath(...).attachSession(...)` 把外部 runtime 会话归入对应工作区；
- **历史回填**：插件启动 1.2s 后扫描 `ctx.sessionQuery.listSessions()`，补登记旧会话；
- 客户端半边更新后需要**重启 DSH**。

## 9. 限制（v1）

- **个人微信走腾讯官方协议**：通过官方 `openclaw-weixin`（iLink）扫码登录，不使用
  iLink/WeChatFerry 等第三方协议；需要手机微信确认，登录态可能被平台作废（`-14`）后需重新扫码。
- **个人微信 v1 仅支持单聊 + 纯文本出站**：官方 iLink 接口目前只稳定提供 1:1 会话，
  **出站图片/文件不支持**；入站图片/文件已下载并 AES 解密（图片内联给视觉模型，文件复制进
  工作区并给 Agent 本地路径），语音只落盘原格式、不转码；详见 [docs/channels/weixin.md](docs/channels/weixin.md)。
- **管理界面**：DSH 侧栏「消息」（原生 React / RPC）；manager HTTP API 只保留给 attach/诊断，不再提供浏览器 UI。个人微信扫码登录仍走二维码流程。
- **没有流式编辑**：Agent 输出完整结束后整段（分片）回复，不做“原地刷新”。
- **DSH Desktop 可见性**：IM 会话由独立 SDK runtime 进程写入 `<DSH_HOME>/sessions`；插件会同步/归组这些会话，`dsh-im-manager sessions` 可用于诊断映射。
- **不做附件内容抽取**：图片/文件只以 URL 或本地路径的文字提示交给 Agent。
- **单渠道单账号**：同一渠道只能配一个账号；多账号需拆多个工作区/实例（不同 `stateDir`/端口），
  且同一账号不要跨工作区并发绑定（会抢长连接）。
- **manager HTTP API 仅本机**：监听 loopback、无登录鉴权/TLS；扫码连接仅支持飞书/微信，
  二维码需手机确认，关闭未确认不会启用；manager.json 修改后需重启 manager。
- **host plugin 的 manager 随 DSH 生命周期**：DSH 退出/插件热重载会停止内嵌 manager（工作区
  短暂中断）；同一 profile 不要同时装两个实例；不要装进 sdk profile。
- **群白名单按群**：`groups.allowFrom` 是 `conversationId` 列表，不按群成员过滤。
- **webhook 不内置 TLS**：生产请用 Caddy/Nginx 终止 TLS。
- 长回复按 `reply.chunkChars` 分片，超过 `reply.maxChunks` 会省略剩余内容（默认 6 片）。

## 10. FAQ

**Q: 启动报 `no config file found`？**
在 DSH 侧栏「消息」给对应工作区创建 Gateway（会生成 `.dsh-im-manager/config.json`），
或用 `--config <path>` / `DSH_IM_MANAGER_CONFIG` 指定已有配置。

**Q: `dsh` 不在 PATH？**
设置 `DSH_IM_MANAGER_DSH=/path/to/dsh`，或改 `dsh.command` 为绝对路径。macOS 桌面版
会自动回退到应用内 CLI。

**Q: 发了消息没反应？**
按顺序排查：`doctor` 是否通过 → DSH 侧栏日志里渠道是否 connected → 是否被访问控制拦
（DM 默认 pairing，先看有没有配对码回复；群聊默认关闭）→ 用 `/id` 拿到发送者 id 加白。

**Q: 群消息为什么没反应？**
`gateway.access.groups.enabled` 默认 `false`；打开后还需要 `requireMention=true` 时 @机器人，
且群 `conversationId` 在 `groups.allowFrom` 中（空数组表示所有群）。

**Q: 需要公网服务器吗？**
飞书 `ws`、钉钉 `stream`、企业微信 `ws`、微信（个人）长轮询都不需要；webhook 模式
（飞书/钉钉/企业微信的回调模式）需要平台能访问网关的 HTTP 端口。

**Q: 为什么没有微信公众号 / 微信客服入口？**
v1 主动砍掉了公众号（`wechat`）和微信客服：公众号回调需要公网 80/443、48h/5 条客服
消息限额，维护成本与收益不成比例。个人微信已通过腾讯官方 `openclaw-weixin`（`weixin`）
覆盖，剩余渠道为飞书 / 钉钉 / 企业微信。旧配置里的 `channels.wechat` 会被当作未知渠道报错，
直接删掉即可。

**Q: 新建工作区后渠道为什么都是关闭的？**
v1.1 起创建只建配置块，启用统一在渠道卡片里做：飞书/微信点「启用」扫码（飞书可选手动填 App ID/Secret），
钉钉/企业微信填好配置保存即启用。详见 [docs/manager.md](docs/manager.md) §6。

**Q: 扫码弹窗关掉会怎样？**
未扫码确认就关闭（X / Esc / 点遮罩 / 取消）会调用 cancel，渠道保持未启用；已确认的会正常启用。

**Q: 微信扫码后还是收不到消息？**
先 `dsh-im-manager weixin status` 确认已登录，再确认 `channels.weixin.enabled=true`，
最后看工作区日志是否有 `-14`（登录态失效，需重新 `weixin login`）或访问控制拦截。

**Q: 回复太长被截断？**
调大 `reply.chunkChars` / `reply.maxChunks`，或让 Agent 输出更短。

**Q: 想换模型？**
改 `dsh.provider` / `dsh.model`（默认 `deepseek-official` / `deepseek-chat`），重启生效。

**Q: 为什么没有独立 CLI manager / Web UI 了？**
运行入口统一到 DSH profile bundle；manager 仍保留 HTTP API 供 attach/诊断，但不再提供
独立进程和浏览器 UI。需要常驻时，让 DSH 保持运行即可。

**Q: 数据存在哪？**
`gateway.stateDir`（默认 `~/.dsh-im-manager`）：`sessions.json`、`dedupe.json`、
`pairing.json`、`gateway.json`、`channels/<id>/`（含微信个人凭据）。

**Q: 能作为 DSH 插件跑吗？**
可以，且 v1.1 默认安装的就是 **manager 模式**（多工作区随 DSH 启停）。`package.json` main 暴露
`name/inject/apply`，`./dsh-plugin` 的配置项：`mode`（`manager` 默认 / `gateway` 旧单工作区）、
`managerFile`、`host`、`port`、`autoStart`、`startAllWorkspaces`（gateway 模式还有 `configFile`）。
插件会先抢 `~/.dsh-im-manager/manager.lock`；已有 manager 时 attach，不会起第二个。
不要装进 `sdk` profile。详见 README §7/§8 与 [docs/manager.md](docs/manager.md) §10。

```bash
bash install/activate.sh          # 把包复制进 profile + 追加 patch row（会热重载插件树）
bash install/verify-plugin.sh     # 在临时 DSH_HOME 的真实 loader 里验证挂载/启停，不动线上 profile
```

插件模式下建议把配置放在 `~/.dsh/im-manager/config.json`（或在 patch row 里给 `configFile`
指向工作区本地配置）。挂载后可在 DSH 对话里使用 `im_gateway_status` / `im_gateway_pair` /
`im_gateway_allow` / `im_gateway_send` 工具。

## 11. 文档索引

- [docs/architecture.md](docs/architecture.md)：分层、数据流、重启语义
- [docs/configuration.md](docs/configuration.md)：完整字段表与环境变量插值
- [docs/security.md](docs/security.md)：配对、白名单、群策略、密钥、webhook
- [docs/operations.md](docs/operations.md)：日志、升级、排障
- [docs/manager.md](docs/manager.md)：多工作区 manager（manager.json / API / DSH 原生页面）
- [docs/channels/index.md](docs/channels/index.md)：四渠道总览
- [docs/verification.md](docs/verification.md)：测试与验证记录
- [docs/contracts.md](docs/contracts.md)：内部接口契约（开发者）
