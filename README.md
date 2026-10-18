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
dsh plugin --profile desktop add ./dsh-im-manager-0.1.0.tgz
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
| 运行形态 | 独立进程 | 独立进程 `serve`，或作为 DSH 插件挂载（`./dsh-plugin`） |
| 管理界面 | 有 | 无，只有 CLI |

好处是：不重复实现 Agent loop，换模型/改工具权限都在 DSH 侧完成；gateway 只关心
消息怎么进来、谁可以用、回复怎么出去。`src/bridge/` 是唯一与 DSH 通信的边界。

**生效范围：绑定单位是工作区，不是单个会话。** 一个 `serve` 实例 = 一个工作区
（`dsh.cwd` + `dsh.home`）= 一个 DSH runtime = 一套渠道账号；工作区内每个 IM 会话
（渠道/账号/聊天/话题）各自一个 DSH session，`/new` 只轮换该会话。多工作区就多实例
（各自 config/stateDir/端口）。`sessions.json` 记录工作区指纹，stateDir 被另一工作区
误用时会丢弃旧绑定并告警。详见 [docs/architecture.md §4.1](docs/architecture.md#41-生效范围绑定单位是工作区会话是工作区内的对话)。

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
- 模型凭据：`dsh.provider` 两条常用路线——
  - `deepseek-account` + `deepseek-flash`：复用本机 DSH 桌面应用已登录的账号（同一 `DSH_HOME`），无需 API key，推荐本机宿主；
  - `deepseek-official` + `deepseek-chat`：需要 `DEEPSEEK_API_KEY`（SDK profile 不共享桌面账号登录）；
- 一个可用的 DSH 安装（`dsh --version` 可执行；找不到时用 `DSH_IM_MANAGER_DSH` 指定路径）；
- 各平台的应用凭证（见下方各渠道入口）。

```bash
cd dsh-im-manager
npm install

# 1) 生成配置：写入 $DSH_HOME/im-manager/config.json（默认 ~/.dsh/im-manager/config.json）
node bin/dsh-im-manager.js init

# 2) 编辑配置，填入密钥；推荐全部使用 env:VAR 占位
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='xxx'

# 3) 体检：配置 / dsh / SDK profile / 端口 / 渠道字段
node bin/dsh-im-manager.js doctor

# 4) 启动（前台常驻，Ctrl+C 停止）
node bin/dsh-im-manager.js serve
```

想把 `dsh-im-manager` 当命令用，可以 `npm link`；否则下文统一写作
`dsh-im-manager`，等价于 `node bin/dsh-im-manager.js`。

> `init` 写入的示例里，飞书/钉钉/企业微信默认 `enabled: true`，
> 微信（个人）默认 `false`（要先扫码登录再打开）；先按需关闭不用的渠道，
> 或把对应 `env:` 变量补全，否则 `doctor` 会把未设置的变量报为 error。

最小可用配置（只开飞书长连接，其他渠道省略）：

```json
{
  "dsh": { "cwd": "/path/to/your/project" },
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "env:FEISHU_APP_ID",
      "appSecret": "env:FEISHU_APP_SECRET"
    }
  }
}
```

完整示例（四渠道；飞书/钉钉/企微用 env 占位，个人微信免密钥）见 [config/config.example.json](config/config.example.json)；
字段细节见 [docs/configuration.md](docs/configuration.md)。

### 接飞书

企业自建应用 → 开启机器人 → 长连接模式（默认 `ws`，不需要公网）。
`appId` / `appSecret` 用 `env:` 写法，详见 [docs/channels/feishu.md](docs/channels/feishu.md)。

### 接钉钉

企业内部应用 → Stream 模式机器人（默认 `stream`，不需要公网）。
需要 `clientId` / `clientSecret` / `robotCode`，详见 [docs/channels/dingtalk.md](docs/channels/dingtalk.md)。

### 接企业微信

智能机器人长连接（默认 `ws`）需要 `botId` / `secret`；自建应用回调用 `webhook` 模式，
需要 `token` / `encodingAESKey` / `corpId` / `agentId`。
详见 [docs/channels/wecom.md](docs/channels/wecom.md)。

### 接微信（个人）

个人微信走腾讯官方 `openclaw-weixin`（iLink HTTP 协议），**扫码登录**、长轮询拉消息，
不需要公网入口：

```bash
# 1) 配置里打开渠道（其余用默认值即可）
#    "channels": { "weixin": { "enabled": true } }

# 2) 终端渲染二维码，用手机微信扫码并确认
dsh-im-manager weixin login

# 3) 查看状态（0=已登录，1=未登录）
dsh-im-manager weixin status

# 4) 启动网关（登录态在 <gateway.stateDir>/channels/weixin/credentials.json，0600）
#    先 serve 后扫码也可以：登录成功后数秒内自动开始收发
dsh-im-manager serve
```

凭据文件等价于微信登录态，不要提交或外传；换号/掉线时重新 `weixin login`，
`weixin logout` 可删除凭据。详见 [docs/channels/weixin.md](docs/channels/weixin.md)。

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
推荐把配置放在工作区内，后续 `pair/serve/doctor` 都不需要 `--config`：

```bash
cd <workspace>
dsh-im-manager init --local          # 写入 .dsh-im-manager/config.json（cwd 自动设为该工作区）
# 启动一次（或已常驻）后，陌生 DM 会收到配对码：
dsh-im-manager pair 123456           # 自动发现当前工作区配置，批准后立即生效
dsh-im-manager list                  # 查看该工作区的 allowlist / 待配对
```

如果网关是以 DSH 插件方式挂在宿主里，也可以在 DSH 对话中让 Agent 调用
`im_gateway_status`（列出待配对码）和 `im_gateway_pair` / `im_gateway_allow` 完成批准；
只有工作区 owner 明确要求时才应批准。多个工作区各自一份配置和 `pairing.json`，
在哪个工作区目录执行 `pair` 就批准哪个实例。

## 6. 管理命令

```bash
dsh-im-manager doctor [--config PATH]      # 体检，非 0 退出码表示有 error
dsh-im-manager status [--config PATH]      # 读 stateDir/gateway.json 并检查 pid
dsh-im-manager channels [--config PATH]    # 列出启用的渠道
dsh-im-manager sessions [--config PATH]    # 列出 IM 会话 → DSH session 映射
dsh-im-manager list [--config PATH]        # 允许列表 / 待配对
dsh-im-manager pair <code>                 # 批准配对码
dsh-im-manager allow <channel>:<senderId>  # 直接加白
dsh-im-manager revoke <channel>:<senderId> # 移出白名单
dsh-im-manager init [--local] [--force] [--config PATH]  # 写入示例配置（--local = 工作区内 .dsh-im-manager/config.json）
dsh-im-manager weixin login|status|logout     # 个人微信扫码登录 / 查看 / 退出
dsh-im-manager manager [--config manager.json] [--host H] [--port 8788]  # 多工作区管理 + Web UI
dsh-im-manager version
```

常驻方式（launchd / systemd）、日志与故障排查见 [docs/operations.md](docs/operations.md)。

## 7. 多工作区管理（Web UI）

一个工作区 = 一个 gateway 实例 = 一个 DSH runtime = 一套渠道账号。如果你要同时接多个项目 /
多套机器人账号，用 `manager` 在一个进程里管理多个工作区，并通过本地 Web UI 增删改查：

```bash
node bin/dsh-im-manager.js manager        # 默认 http://127.0.0.1:8788/
```

最短流程：打开 UI → 「添加工作区」（名称 + 工作目录 + 勾选要用的渠道）→ **新建工作区的所有渠道
默认都是关闭的** → 在渠道卡片里启用（飞书/微信点「启用」扫码；钉钉/企微保存配置即启用）→
点「开始」。配对请求、日志、启停/重启都在同一个页面；每个工作区有独立的配置、`stateDir`、
会话与 DSH runtime。

渠道扫码连接（v1.1）：

- **飞书**卡片「启用」→ 弹窗双 tab：**扫码创建/登录**（默认）或 **手动填写** App ID / Secret；
- **微信（个人）**卡片「启用」→ 仅二维码弹窗（扫码后凭据写本地，配置只置 `enabled:true`）；
- **关闭弹窗（X / Esc / 点遮罩 / 取消）且未确认 = 渠道不启用**（会调用 cancel）；
- 钉钉/企业微信仍是「保存配置即启用」；
- 已启用渠道再次连接会返回 409，需先停用/关闭。

- **manager.json**：默认 `~/.dsh-im-manager/manager.json`（`--config` 可指定），只记录工作区列表与
  UI 监听地址，不存渠道密钥；首次启动会自动创建，并尝试把当前目录（若已有
  `.dsh-im-manager/config.json`）加入。
- **工作区配置**：新建时写到 `<workspaceDir>/.dsh-im-manager/config.json`，
  `stateDir=<managerDataDir>/workspaces/<id>/state`、`http.port=0`（随机端口），
  `dsh.cwd=workspaceDir`；渠道格式与单工作区完全一致（见 [docs/configuration.md](docs/configuration.md)）。
- **安全**：只监听 `127.0.0.1:8788`，**无鉴权、无 TLS**；配置 API 与日志里的密钥一律显示/记录为 `***`。
  不要直接暴露到公网；确需远程访问请自行反代 + 强鉴权。
- **限制**：扫码连接只支持飞书/微信（钉钉/企微保存即启用）；二维码需手机真实确认；
  同一渠道账号不要同时绑定到多个工作区（会抢长连接）；保存配置会重启该工作区，
  进行中的一轮对话会中断。

完整说明（架构、manager.json、API 表、UI 使用、排障、限制）见 [docs/manager.md](docs/manager.md)。

## 8. 在 DSH 宿主里运行（host plugin，manager 模式）

除了独立进程（`serve` / `manager`），本项目还可以作为 **DSH 宿主插件**加载。v1.1 起插件支持
`mode: manager`（默认安装模式）：DSH 启动时在**宿主进程内**启动 manager（HTTP API + Web UI），
多工作区随 DSH 的生命周期一起启停。

```bash
bash install/activate.sh            # 默认 desktop profile，安装 manager 模式
DSH_PROFILE=web bash install/activate.sh
bash install/activate.sh --gateway  # 旧行为：只跑单工作区 gateway
bash install/activate.sh --remove   # 卸载 patch row（包保留在 profile 里）
bash install/verify-plugin.sh       # 隔离 DSH_HOME 验证加载/启动/释放，不动线上 profile
```

- **启动后发生什么**：DSH 加载 profile → 插件 `apply` → 内嵌 manager（owned）→ 启动
  `autoStart` 的工作区；Web UI 仍是 `http://127.0.0.1:8788/`，配置仍是
  `~/.dsh-im-manager/manager.json`。
- **单实例锁 / attach**：manager 用 `~/.dsh-im-manager/manager.lock`（`0600`，记录 pid/token/
  host/port）保证同一时刻只有一个 owner。锁已被另一个进程持有（独立 CLI manager 或另一个宿主）时，
  插件**attach** 到它的 HTTP API，不重复启动、不抢渠道；插件 dispose 只停自己拥有的 manager。
  独立 CLI `manager` 也检查同一把锁：第二个会打印「manager 已在运行（pid …）：http://…」并退出 0。
- **端口**：默认 `8788`（`activate.sh` 支持 `DSH_IM_MANAGER_PORT`、`DSH_IM_MANAGER_FILE`）；
  端口已被一个**健康**的 manager 占用时插件会 attach 而不是报错。
- **不要装进 `sdk` profile**：gateway 会再 spawn 自己的 SDK runtime，manager 模式在
  `--profile sdk` 里会**直接拒绝启动**（防递归）。请装在 `desktop` / `web` 等宿主 profile。
- **工具**：挂载后 DSH 对话里可用 `im_gateway_status`（聚合所有工作区）、`im_gateway_pair`、
  `im_gateway_allow`、`im_gateway_send`；pair/allow/send 支持可选 `workspace`
  （多个工作区在运行时必填，按 id/name/workspaceDir 解析）。
- **现状**：2026-10-18 已安装进真实 `desktop` profile（`~/.dsh/profiles/desktop` 下的包 + `im-manager` patch row）。DSH 重启后 manager 以 DSH 宿主 pid owned 启动，`dsh` 工作区随 `autoStart` 拉起；已在 DSH 会话内成功调用 `im_gateway_status` 工具。owned/attach 两种模式都已在隔离 profile 验证；D-v2 原生页面已实现（见下）。

### 8.1 DSH 原生页面（D-v2）

包同时导出了浏览器半边（`lib/client.js` + `dsh.client`）。安装后 DSH **左侧栏** 会出现
**「消息」**（在「插件」和「自动化任务」之间），只保留侧栏入口。
页面是原生 React 实现，不嵌入 iframe，也不依赖固定 8788 端口：

- 数据/操作走宿主 handler 注册的 **同源 RPC 通路** `/im-manager`（`Connection` 的
  owner-only 门禁），浏览器半边通过 `ctx.connection.rpc.call` 调用；
- 界面与交互对齐 DSH 内置「插件」页：`dim-page` 布局、列表行/详情页两级导航、
  DSH UI primitives（Button/Input/Icon）、`--dsw-alias-*` 主题 token（浅色/深色自适应）；
- **工作区发现**：列表来自 `ctx.workspaceRegistry`（当前 profile 的所有 DSH 工作区），
  没有 Gateway 的工作区显示「未创建 Gateway」，可在详情里「创建 Gateway / 创建并启动」；
  不属于当前 profile 的 manager 条目单独放在「其他 Gateway 条目」；
- 支持：工作区列表/详情、启停/重启/删除/添加、渠道行内操作（飞书/微信扫码启用、停用）、
  钉钉/企微/飞书的完整凭据/模式/Webhook 字段配置弹窗、配对批准/allowlist、日志、自动启动开关；
- **IM 会话同步**：客户端插件每 2s 读取 manager 的 session activity；首次 IM 消息或 `/new`
  造成会话绑定变化时，调用 DSH client 的 `sessions.refresh()`，让该 IM 会话自动出现在
  DSH Desktop 左侧对应工作区下（首次消息默认建 session，后续沿用，直到 `/new`）；
  宿主同时调用 `workspaceRegistry.resolveByPath(...).attachSession(sessionId)` 把外部 runtime
  写入的会话登记进对应 DSH workspace，避免落入「未分组」；
- **历史会话回填**：插件启动后 1.2s 执行一次 `ctx.sessionQuery.listSessions()` 全量扫描，
  把 cwd 匹配但尚未记入 workspace 的旧会话通过 `attachSession` 补登记（修复升级前遗留的
  「未分组」会话）；
- 高级渠道字段（钉钉/企微密钥等）仍可在 `http://127.0.0.1:8788/` 的 manager Web UI
  或配置文件里配置；manager UI 与 DSH 页面共用同一个 manager 实例；
- 首次安装/更新客户端半边后需要**重启 DSH**（client 组合在页面启动时构建）；
- 单元测试：`test/host/client-bundle.test.js`（bundle 注册、sidebar/main/settings、
  RPC 端点、无 iframe/固定端口、Plugins 风格 class/token）与 `test/host/manager-rpc.test.js`
  （宿主 RPC 分发）。

完整字段、生命周期与排障见 [docs/manager.md](docs/manager.md) §10。

## 9. 限制（v1）

- **个人微信走腾讯官方协议**：通过官方 `openclaw-weixin`（iLink）扫码登录，不使用
  iLink/WeChatFerry 等第三方协议；需要手机微信确认，登录态可能被平台作废（`-14`）后需重新扫码。
- **个人微信 v1 仅支持单聊 + 纯文本出站**：官方 iLink 接口目前只稳定提供 1:1 会话，
  **出站图片/文件不支持**；入站图片/文件已下载并 AES 解密（图片内联给视觉模型，文件复制进
  工作区并给 Agent 本地路径），语音只落盘原格式、不转码；详见 [docs/channels/weixin.md](docs/channels/weixin.md)。
- **管理界面**：独立 Web UI 在 `http://127.0.0.1:8788/`；DSH 侧栏提供原生「消息」页面（D-v2，RPC 驱动，支持工作区/渠道/扫码/配对/日志）。个人微信扫码登录仍走二维码流程。
- **没有流式编辑**：Agent 输出完整结束后整段（分片）回复，不做“原地刷新”。
- **DSH Desktop 可见性**：IM 会话由独立 SDK runtime 进程写入 `<DSH_HOME>/sessions`；Desktop 的会话列表是宿主维护的，外部进程新建的会话通常需要刷新/重开窗口才会出现（CLI `dsh-im-manager sessions` 可随时确认映射）。
- **不做附件内容抽取**：图片/文件只以 URL 或本地路径的文字提示交给 Agent。
- **单渠道单账号**：同一渠道只能配一个账号；多账号需拆多个工作区/实例（不同 `stateDir`/端口），
  且同一账号不要跨工作区并发绑定（会抢长连接）。
- **manager/Web UI 仅本机**：监听 loopback、无登录鉴权/TLS；扫码连接仅支持飞书/微信，
  二维码需手机确认，关闭未确认不会启用；manager.json 修改后需重启 manager。
- **host plugin 的 manager 随 DSH 生命周期**：DSH 退出/插件热重载会停止内嵌 manager（工作区
  短暂中断）；同一 profile 不要同时装两个实例；不要装进 sdk profile。
- **群白名单按群**：`groups.allowFrom` 是 `conversationId` 列表，不按群成员过滤。
- **webhook 不内置 TLS**：生产请用 Caddy/Nginx 终止 TLS。
- 长回复按 `reply.chunkChars` 分片，超过 `reply.maxChunks` 会省略剩余内容（默认 6 片）。

## 10. FAQ

**Q: 启动报 `no config file found`？**
先跑 `dsh-im-manager init`，或用 `--config <path>` / `DSH_IM_MANAGER_CONFIG` 指定。

**Q: `dsh` 不在 PATH？**
设置 `DSH_IM_MANAGER_DSH=/path/to/dsh`，或改 `dsh.command` 为绝对路径。macOS 桌面版
会自动回退到应用内 CLI。

**Q: 发了消息没反应？**
按顺序排查：`doctor` 是否通过 → `serve` 日志里渠道是否 connected → 是否被访问控制拦
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
最后看 `serve` 日志是否有 `-14`（登录态失效，需重新 `weixin login`）或访问控制拦截。

**Q: 回复太长被截断？**
调大 `reply.chunkChars` / `reply.maxChunks`，或让 Agent 输出更短。

**Q: 想换模型？**
改 `dsh.provider` / `dsh.model`（默认 `deepseek-official` / `deepseek-chat`），重启生效。

**Q: host plugin 和 CLI manager 怎么选？**
想「DSH 打开时才接 IM」用 host plugin（`bash install/activate.sh`，manager 模式）；
想「开机常驻、不依赖 DSH 窗口」用 CLI `manager` + launchd/systemd。两者共用
`~/.dsh-im-manager/manager.lock`：一边在跑时，另一边会 attach（host）或提示已在运行（CLI）。

**Q: 数据存在哪？**
`gateway.stateDir`（默认 `~/.dsh-im-manager`）：`sessions.json`、`dedupe.json`、
`pairing.json`、`gateway.json`、`channels/<id>/`（含微信个人凭据）。

**Q: 能作为 DSH 插件跑吗？**
可以，且 v1.1 默认安装的就是 **manager 模式**（多工作区随 DSH 启停）。`package.json` main 暴露
`name/inject/apply`，`./dsh-plugin` 的配置项：`mode`（`manager` 默认 / `gateway` 旧单工作区）、
`managerFile`、`host`、`port`、`autoStart`、`startAllWorkspaces`（gateway 模式还有 `configFile`）。
插件会先抢 `~/.dsh-im-manager/manager.lock`；已有 manager 时 attach，不会起第二个。
不要装进 `sdk` profile。详见 README §8 与 [docs/manager.md](docs/manager.md) §10。

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
- [docs/operations.md](docs/operations.md)：常驻、日志、升级、排障
- [docs/manager.md](docs/manager.md)：多工作区 manager + Web UI（manager.json / API / UI）
- [docs/channels/index.md](docs/channels/index.md)：四渠道总览
- [docs/verification.md](docs/verification.md)：测试与验证记录
- [docs/contracts.md](docs/contracts.md)：内部接口契约（开发者）
