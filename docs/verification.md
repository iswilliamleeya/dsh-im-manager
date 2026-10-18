# 验证记录

> 记录时间：2026-10-17（Asia/Shanghai）。
> 环境：macOS，Node v24.20.0，`dsh` CLI 0.2.1-rc.2（macOS 应用内置路径），
> 项目目录 `dsh-im-manager`，依赖已安装。

## 1. 结论

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `cd dsh-im-manager && npm test` | **661 通过 / 0 失败**（51 suites） |
| e2e 子集 | `node --test 'test/e2e/*.test.js'` | **27 通过 / 0 失败** |
| host（插件/锁/嵌入 manager）单测 | `node --test 'test/host/*.test.js'` | **14 通过 / 0 失败** |
| manager 单测 | `node --test 'test/manager/*.test.js'` | **175 通过 / 0 失败** |
| Web UI 单测 | `node --test 'test/webui/*.test.js'` | **29 通过 / 0 失败** |
| 微信（个人）单测 | `node --test 'test/adapters/weixin/*.test.js'` | **161 通过 / 0 失败** |
| CLI 冒烟 | `node bin/dsh-im-manager.js version` | `0.1.0`，退出码 0 |
| CLI 帮助 | `node bin/dsh-im-manager.js help` | 打印用法，退出码 0 |

`npm test` 全程约 4.0s，进程正常退出（无残留子进程）。
> 注：改装 host plugin 后首次全量跑曾出现 1 次未复现的失败；随后连续 4 次均为 640/640，
> 已作为“偶发”记录在 §9。
`npm test` 覆盖：`test/core`（配置/访问控制/会话/去重/分片/HTTP/网关循环）、
`test/bridge`（真实子进程 JSON-RPC、重启、shutdown）、`test/adapters/*`（四渠道：飞书/钉钉/企业微信/微信个人；微信个人 161 个用例覆盖 iLink 协议、QR 登录、
长轮询、凭据、入站媒体下载+解密、出站、typing）、`test/manager/*`（多工作区生命周期/配置存储/API/渠道扫码连接状态机，175）、
`test/host/*`（嵌入 manager、单实例锁、manager HTTP client/workspace 解析、宿主 RPC、client bundle，25）、
`test/webui/*`（静态 UI、前端契约、扫码弹窗与 connect 客户端，29）、
`test/e2e`（真实 gateway/manager+adapter+bridge 闭环，27）。

## 2. 真实 DSH 宿主插件挂载验证（非 mock）

在**隔离的临时 DSH_HOME** 里从官方 `sdk` profile 模板创建真实 profile，用 `install/activate.sh`
（默认 `mode: manager`）安装本插件，boot 宿主（stdin EOF 退出）并开启
`DSH_IM_MANAGER_PLUGIN_TRACE=1` 观察生命周期。跑 `bash install/verify-plugin.sh` 实测输出：

```bash
$ bash install/verify-plugin.sh
1/5 materialize profile 'im-manager-verify' from the shipped sdk template
2/5 install plugin into .../home/profiles/im-manager-verify (manager mode, port 0)
3/5 write empty manager.json (no workspaces; lifecycle only)
4/5 boot the profile (stdin closed)
5/5 assertions
OK: host plugin loaded in manager mode, started the embedded manager, and disposed cleanly
manager file: .../home/im-manager/manager.json
```

trace 中的关键行：
`plugin apply: registering tools (manager mode)` → `manager mode: owned at http://127.0.0.1:<port>`
→ `plugin dispose: stopping embedded manager`，并且 `manager.lock` 在 dispose 后已释放。

**attach 模式**（隔离 profile 指向本机已在运行的 manager，`DSH_IM_MANAGER_FILE` 指向其
`manager.json`、端口 8788）实测：

```text
[im-manager] plugin apply: registering tools (manager mode)
[im-manager] manager mode: attach at http://127.0.0.1:8788 (managerFile=/Users/.../.dsh-im-manager/manager.json)
[im-manager] plugin dispose: stopping embedded manager
```

- attach 没有创建第二个 manager；`~/.dsh-im-manager/manager.lock` 的 token/pid 前后不变；
- attach 对象 dispose 时不会停止 owner；期间 `GET /api/health` 仍为 `{"ok":true}`。

结论：`package.json` main 暴露 `name/inject/apply`；DSH loader 能加载插件并注册工具；
manager 模式能 owned 启动 / attach 已有 manager / dispose 并释放锁；没有 "did not activate"。

### 2.1 真实 desktop profile 安装（2026-10-18，本机）

在 William 重启 DSH Desktop 后，把插件安装进**真实** `desktop` profile：

```bash
cd /Users/williamlee/Documents/DSH/dsh-im-manager
bash install/activate.sh
# 1/3 copying package -> ~/.dsh/profiles/desktop/node_modules/dsh-im-manager
# 2/3 appending plugin row to ~/.dsh/profiles/desktop/cordis.patch.yml
#     backup: ...cordis.patch.yml.before-im-manager-20261018-202010
# 3/3 resolved: dsh-im-manager / OK
# Mode: manager (multi-workspace)
```

安装后 2 秒内（patch watcher 热加载），manager 在 **DSH Desktop 宿主进程**里 owned 启动：

```json
// ~/.dsh-im-manager/manager.lock
{"version":1,"pid":74792,"token":"…","host":"127.0.0.1","port":8788,
 "managerFile":"/Users/williamlee/.dsh-im-manager/manager.json","startedAt":…}
```

- `pid 74792` 是 DSH Desktop 宿主进程，不是独立 CLI manager；
- `GET /api/health` → `{"ok":true}`；
- `/api/state`：`dsh` workspace `running` / `bridge=ready` / `feishu:connected, weixin:connected`；
- `dsh` workspace 的 `autoStart=true`，由 `manager.start()` 拉起；其 DSH SDK runtime 子进程
  （`--profile sdk`）挂在宿主进程下；
- 在 DSH Desktop 的 Agent 会话里直接调用 `im_gateway_status` 工具成功，返回
  `1/3 workspace(s) running`、`dsh/feishu: connected`、`dsh/weixin: connected`、`pending: none`，
  说明 host plugin 的工具注册和 manager HTTP 链路都已生效。

至此 B 方案（DSH 启动 → 宿主内嵌 manager → autoStart 工作区）在真实环境闭环。

### 2.2 DSH 原生页面（D-v2，2026-10-18）

在隔离 `web` profile 里安装并启动真实 web 宿主后，用浏览器（Tabbit）验证：

```bash
TMP=$(mktemp -d); DSH_HOME=$TMP dsh im-web-v2 --from-default-profile web --dump-config
DSH_HOME=$TMP DSH_PROFILE=im-web-v2 DSH_IM_MANAGER_PORT=8788 \
  DSH_IM_MANAGER_FILE=~/.dsh-im-manager/manager.json bash install/activate.sh
DSH_HOME=$TMP dsh im-web-v2 --no-open --port 0
# 打印 http://127.0.0.1:<port>/?token=…
```

结果：

- 左侧栏出现 **「消息」**（插件与自动化任务之间）；点击后主区域渲染**原生 React 页面**，
  `document.querySelectorAll('iframe').length === 0`；弹窗在右侧主面板内居中（overlay 宽度 = `.dim-page` 宽度，非整个窗口）；
- 页面通过宿主 RPC `/im-manager` 拉到真实 manager 数据：工作区列表、`running`、
  `bridge: ready`、`feishu/weixin connected`、日志 200 行；
- 「手动配置飞书」弹窗（App ID/Secret/Domain）可打开/取消；「添加工作区」弹窗存在；
- 宿主注册日志：`native rpc: route /im-manager registered`；直接 POST 该路由返回
  `{"type":"server-response","result":{"ok":true,"value":{...}}}`；
- 深色模式：切到深色后列表/详情/配置弹窗均使用 `--dsw-alias-*` token，无白底白字问题；
- 会话同步（D-v2.2/D-v2.3）：manager `getSessionActivity()` + `/api/sessions/activity` + RPC
  `activity` 已有单测；client 每 2s 轮询并在 revision 变化时 `ctx.sessions.refresh()`（首次消息/`/new`）；
  host 插件在 activity 时通过 `workspaceRegistry.resolveByPath(...).attachSession(...)` 把外部
  runtime 的会话登记进对应 workspace（`test/host/workspace-attach.test.js`），修复「未分组」；
  隔离 web profile 实测 `workspaceRegistry available`；

- 交互：列表行进入详情、返回面包屑、配置弹窗、删除确认、暂停轮询等按「插件」页风格；
- 截图：`staging/dsh-im-manager-native-page.png`（列表，深色）与
  `staging/dsh-im-manager-native-detail.png`（详情）。
- **DSH 工作区发现（D-v2.5）**：隔离 web profile + owned manager，列表来自
  `workspaceRegistry`（实测 `default-workspace` 显示「未创建 Gateway」）；详情「创建 Gateway」
  后 manager 条目生成、渠道行出现；钉钉配置弹窗包含 mode/clientId/clientSecret/robotCode/
  signatureSecret/webhookPath/botUserId。截图：`staging/dsh-im-manager-discovery-list.png` /
  `staging/dsh-im-manager-discovery-detail.png`。

说明：真实 `desktop` profile 已通过 `activate.sh` 复制最新包，但 DSH 需要**重启**后才会加载
新的 host RPC 路由/client bundle；重启后按同一路径验证即可。D-v1 的 iframe 实现已被 D-v2 替换。

## 3. 真实模型 + 当前工作区验证（非 mock，Lead 执行）

用 `dsh.provider=deepseek-account` / `deepseek-flash`（复用桌面账号登录，同一 `DSH_HOME`），
在**当前工作区** `/Users/williamlee/Documents/DSH` 下通过 gateway 走了一轮真实模型：

```text
bridge: ready workspace: /Users/williamlee/Documents/DSH
reply: ["HOST_OK"]   elapsed_ms: 1576
```

同时 `serve` 以该工作区为宿主启动（真实 DSH bridge ready，微信渠道等待扫码登录），
`status` 与 `/healthz` 均返回正确工作区与渠道状态。

## 4. 真实 DSH runtime 协议验证（非 mock，Lead 执行）

在隔离的 `DSH_HOME` 下真实启动 `dsh --profile sdk`，通过 stdio 跑通了：

- `initialize` → `serverInfo.name = deepseek-harness-sdk-runtime`；
- `session/prompt` → 收到真实 `turn/start`、`step`、`assistant/attempt`、`turn/end`；
- `session/wait` → 正常返回；
- `shutdown` → 进程正常退出。

说明 gateway 依赖的 wire protocol 与 waiter 假设（事件顺序、turn 关联、shutdown）已用
**真实 runtime** 验证。由于隔离 home 没有配置 API key，模型步报 `no API key`（预期行为，
不是 gateway 问题）；模型生成环节由 `fake-dsh-runtime.js` 覆盖。

## 5. E2E 覆盖（test/e2e/）

每个 e2e 文件都启动**真实**的 `createGateway`（core + 真实 adapter + 真实 bridge +
真实 HTTP host），只有两端是假的：DSH runtime 用 `test/support/fake-dsh-runtime.js`
（真实子进程、真实 stdio JSON-RPC），IM 平台 API 用本地 `node:http` 假服务；
入站事件是对网关 HTTP 路由发起的**真实请求**（含真实签名 / AES 加解密）。

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `dingtalk.e2e.test.js` | 3 | webhook 签名校验通过→sessionWebhook 出站 markdown；错误签名 401 且不进入 Agent；allowlist 静默丢弃 |
| `feishu.e2e.test.js` | 4 | `url_verification` challenge 同步返回；DM 事件→fake DSH→`im/v1/messages/:id/reply`（interactive card）；verification token 错误 403；群消息未 @ 丢弃 |
| `wecom.e2e.test.js` | 4 | GET 校验（解密 echostr）；AES 加密 XML 入站→fake DSH→`message/send`（markdown）；错误签名 401；allowlist 静默丢弃 |
| `weixin.e2e.test.js` | 4 | iLink 长轮询入站→fake DSH→`sendmessage` 回复；typing（getconfig/sendtyping）best-effort；运行中写入凭据后自动启动 monitor；CLI `weixin status/logout` 反映凭据文件 |
| `channel-connect.e2e.test.js` | 2 | 真实 manager HTTP API + flow 状态机 + 配置写入 + 工作区生命周期；仅把微信/飞书 QR provider 注入为 fake：weixin 扫码确认→`enabled:true`，feishu 扫码确认→写 appId/appSecret/domain；cancel→`cancelled` 且 `enabled:false` |
| `embedded-manager.e2e.test.js` | 2 | 真实 `startEmbeddedManager`：owned 模式抢锁/起工作区/服务 API/释放锁；attach 模式复用已运行 manager 的 API，不创建第二个 manager（另含 host 单测覆盖 stale lock/端口健康回退/sdk 守卫） |
| `manager.e2e.test.js` | 1 | 真实 manager + 两个真实 gateway（不同工作区、不同渠道绑定）+ 真实 HTTP API/静态 UI：两工作区并行运行、`/api/state`、脱敏配置、配对列表+批准落盘、静态首页、停止单个工作区 |
| `cli.e2e.test.js` | 7 | `init` 写配置/不覆盖/`--local` 工作区配置；`doctor` 成功（含 `--version`、`--profile sdk --dump-config`、端口、渠道校验）；缺失 env → error 退出 1；缺失/损坏配置退出 1；`status` 无状态文件退出 1；真实 `serve` 子进程 → `status --json` 退出 0、SIGINT 后退出 1 |

关键断言：`turn/end` 后 adapter 的**真实出站请求**被捕获且文本等于 fake runtime 的回复；
访问控制、配对、去重、分片都在真实 core 路径上生效。

> **微信（个人）验证范围**：`weixin.e2e.test.js` 启动真实 gateway+adapter，通过 fake iLink
> HTTP 端点验证 getupdates→core→fake DSH→sendmessage 闭环、typing（getconfig/sendtyping 1/2）、
> 运行中写入凭据自动启动 monitor、CLI `weixin status/logout` 子进程；QR 登录状态机由 115 个
> adapter 单测覆盖（fake iLink 后端，含 credential `0600` 写入）；`doctor` 的已登录/未登录两种
> 输出均已核对。真实手机扫码（二维码/数字验证码）仍无法自动化。

## 6. 真实 / Mock 对照

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| core（路由/访问控制/会话/去重/分片/HTTP/配置/日志） | **真实** | 直接 `import src/index.js` 的 gateway |
| 四个渠道 adapter（飞书/钉钉/企微/微信个人） | **真实** | 真实平台协议解析、签名/AES、出站请求构造（含微信个人 iLink 长轮询） |
| DSH bridge（子进程 + JSON-RPC） | **真实** | 真实 spawn / stdio / initialize / prompt / 事件 / shutdown |
| CLI（serve/doctor/status/init/pair/weixin login/sessions） | **真实** | 以子进程方式跑 `bin/dsh-im-manager.js` |
| manager（多工作区生命周期 + API） | **真实** | `createManager` + 真实 gateway 实例；e2e 用 fake DSH runtime |
| Web UI（静态三件套 + 前端契约） | **真实** | `src/webui/` 由真实 manager HTTP 服务；静态/契约单测 + Lead 用浏览器渲染验证 |
| 渠道扫码 provider（微信 iLink / 飞书 registerApp） | **e2e fake；8788 上部分真实** | e2e 注入 fake provider；本机 8788 实测真实 provider 能生成二维码并 cancel（未真实扫描确认） |
| DSH 宿主插件挂载（manager 模式） | **真实（隔离 profile）** | 临时 DSH_HOME + 官方 sdk 模板，走真实 loader；owned/attach + 锁释放见 §2 |
| embedded manager（`src/host/*`） | **真实** | 真实 lock 文件/HTTP API/manager 生命周期；e2e 与隔离 profile 覆盖 owned/attach，provider 仍为 fake |
| DSH runtime 本身 | **mock（e2e）** | `fake-dsh-runtime.js` 按契约实现协议；真实 runtime 的 wire protocol 验证见 §4 |
| 微信（个人）iLink 平台 | **mock** | e2e 用本地 fake iLink 端点；单测注入 fake fetch/transport；QR 扫码需真人手机，未自动化 |
| 微信（个人）真实账号 | **部分真机** | 已真实扫码登录/收发（§7.5）；入站媒体下载未用真实账号复测 |
| Feishu/DingTalk/WeCom/Weixin 平台 API | **mock** | 本地 HTTP 假服务，捕获出站请求 |
| 平台事件投递 | **真实 HTTP + 真实密码学** | 按平台协议构造/签名/加密后 POST 到网关路由 |
| 真实平台账号、公网、TLS | **未验证** | 本环境没有平台凭证与公网入口 |

## 7. 手动 CLI 冒烟（可复现）

```bash
cd dsh-im-manager

# 版本 / 帮助
node bin/dsh-im-manager.js version           # 0.1.0，exit 0
node bin/dsh-im-manager.js help              # 用法，exit 0

# 微信（个人）登录态（未登录时退出码 1）
node bin/dsh-im-manager.js weixin status --config config/config.example.json

# 示例配置：飞书/钉钉/企业微信启用且是 env: 占位（个人微信默认关闭），未设置环境变量时应当失败
node bin/dsh-im-manager.js doctor --config config/config.example.json

# manager + Web UI（另一个终端/常驻进程）
node bin/dsh-im-manager.js manager --port 8788
curl -s http://127.0.0.1:8788/api/health
curl -s http://127.0.0.1:8788/api/state
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:8788/
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8788/../package.json'
```

本环境实测：

- 未设置 `FEISHU_*` / `DINGTALK_*` / `WECOM_*` 时，`doctor` 报告 `config.env` error
  （7 个缺失变量）并退出 1 —— 这是示例配置的预期行为；
- `dsh --version` 通过（`0.2.1-rc.2`）；
- `dsh --profile sdk --dump-config` 在本 agent 沙箱内因无法写 `~/.dsh/profiles` 报
  `EPERM`（**这是本验证环境的沙箱限制，不是产品问题**）；`cli.e2e.test.js` 用假 `dsh`
  可执行文件覆盖了 `doctor` 的通过路径（含 profile 检查、端口检查）；
- `status --config config/config.example.json` 无 `gateway.json` 时打印「网关未运行」并退出 1；
- `weixin status --config config/config.example.json` 实测输出
  `凭据文件：~/.dsh-im-manager/channels/weixin/credentials.json` + `状态：未登录…`，退出 1；
  `weixin login/logout` 需要交互式终端与真实微信扫码，本环境未自动化。
- `serve` + `status` 的完整 round-trip 见 `cli.e2e.test.js` 最后一个用例；
- manager 冒烟见 §7.6（健康检查、双工作区状态、静态资源、路径穿越 404 均实测）；
- **单实例锁**实测：manager 已在 8788 运行时，再执行 `node bin/dsh-im-manager.js manager`，
  输出 `manager 已在运行（pid 72255）：http://127.0.0.1:8788/`，退出码 0，`manager.lock` 的
  token/pid 不变（没有起第二个 manager）；
- **host plugin（隔离 profile）**：`bash install/verify-plugin.sh` 实测
  `OK: host plugin loaded in manager mode, started the embedded manager, and disposed cleanly`；
  attach 实测输出 `manager mode: attach at http://127.0.0.1:8788`，锁 token 不变、health ok（§2）。

真实环境里要跑通 `doctor`，需要：可写的 `~/.dsh`（或配置 `dsh.home`）、已安装的 DSH
SDK profile、以及填好的平台密钥。

## 7.5 微信真机联调（2026-10-17 本机）

- 真实扫码登录成功（bot `46e494969e5b@im.bot`），网关 `weixin connected`；
- 真实入站文本/图片均到达（日志含 `attachments:1`）；配对、白名单、主动 `sendmessage` 均验证；
- 真机联调发现并修复：headless runtime 工具审批会挂起 → `approval.policy=never` patch；
  图片仅透传 URL → 新增入站媒体下载 + AES-128-ECB 解密 + 落盘（weixin 单测 161；当前全量 597，见 §1）；
  外部 SDK 会话在 Desktop 侧栏需要刷新/重开才可见（新增 `/sessions`、`dsh-im-manager sessions`、
  `/new` 立即 materialize）。

## 7.6 多工作区 manager + Web UI 联调（2026-10-17 本机，非 mock）

manager 以 `node bin/dsh-im-manager.js manager --port 8788` 常驻，`~/.dsh-im-manager/manager.json`
（`0600`）中登记两个工作区，两个工作区**同时运行**：

| 工作区 | workspaceDir | 渠道 | 状态 |
| --- | --- | --- | --- |
| `dsh` | `/Users/williamlee/Documents/DSH` | `weixin`（iLink 长轮询） | `running`，`weixin connected`，HTTP `8787` |
| `demo-feishu` | `/Users/williamlee/Documents/DSH/staging/im-manager-demo` | `feishu`（webhook，演示用假 appId/secret） | `running`，`feishu connected`，HTTP 随机端口 |

实测（`curl`）：

- `GET /api/health` → `{"ok":true}`；
- `GET /api/state` → `manager.workspaceCount=2`，两个工作区 `state=running`、`bridge=ready`，
  `channels[].health=connected`，`http.publicBaseUrl` 分别为固定端口/随机端口；
- `GET /api/workspaces/demo-feishu/config` → 同构配置，密钥字段为 `***`
  （`appSecret` / `verificationToken`），`env:` 占位保留；
- `GET /api/workspaces/dsh/logs?lines=3` → 返回已脱敏的日志行；
- `GET /api/workspaces/dsh/pairing` → `{pending:[], pendingPairings:[]}`；
- 静态 `GET /`、`/app.js`、`/style.css` → 200 且 content-type 正确
  （`text/html` / `text/javascript` / `text/css`）；`GET /../package.json` → 404；
- UI 由 Lead 用浏览器（Tabbit）打开 `http://127.0.0.1:8788/` 验证：左侧两个工作区 +
  渠道 chips、右侧渠道卡片/配对/日志正常渲染；
- 通过 API 完成过：启动工作区、`PUT` 配置（`***` 脱敏回写、保留旧密钥）、添加工作区、
  两工作区并行运行。

> 说明：UI 的「完整人工点击流程」（逐项编辑并保存、删除确认、滚动日志等）由 Lead 在浏览器里
> 验证；本组自动化覆盖到 manager/API/静态 UI 契约与 e2e，见 §5。

## 7.7 渠道扫码连接真机验证（2026-10-18，manager 8788）

在真实 manager（`--port 8788`）上对停止状态的演示工作区 `qr`（所有渠道默认 disabled）实测
`channels/:channel/connect` API：

| 操作 | 结果 |
| --- | --- |
| `POST /api/workspaces/qr/channels/weixin/connect` `{mode:"qr"}` | `200`，`state=pending`，返回 `qr.dataUrl`（PNG data URL，实测约 6.4k 字符；Lead 复测约 7.0k） |
| `GET .../weixin/connect` | `200`，`state=pending`（终止后 10 分钟内仍可查） |
| `POST .../weixin/connect/cancel` | `200`，`flow.state=cancelled`；`GET config` 中 `weixin.enabled=false` |
| `POST .../feishu/connect` | `200`，`state=pending`，`qr.dataUrl` 约 7.0k 字符（Lead 复测 6942） |
| `POST .../feishu/connect/cancel` | `cancelled`；`feishu.enabled=false` |
| 错误码 | 未知 workspace `404`；`dingtalk` connect `400`；已启用渠道（`dsh` 的 weixin）`409` |
| UI（Lead 用 Tabbit 打开 8788） | 微信卡片「启用」→ 二维码弹窗；飞书卡片「启用」→ 双 tab（扫码/手动表单）；关闭弹窗取消路径正常 |

参考截图（Lead 提供，位于 workspace 根目录 `staging/`）：`staging/im-manager-weixin-qr.png`、
`staging/im-manager-feishu-manual.png`（本仓库外，不随项目分发）。

> 未做：真实手机扫码并在手机上确认（微信 `confirmed` / 飞书 `registerApp` 确认），因此
> `confirmed` 后的真实账号收发、飞书扫码创建出的应用权限均未验证；cancel 后二维码在平台侧的
> 实际失效时间也未验证。自动化用注入 provider 覆盖到状态机与配置写入（§5）。

## 8. 验证期间发现并修复的问题

1. **WeCom adapter 生命周期**：`stop()` 未清空内部 runtime 句柄，同进程第二次 `start()`
   抛 `already been started`，导致 webhook 路由不注册（表现为 404）。已由 Lead 修复
   （`stop()` 末尾置 `runtime = null`），修复后 e2e 以每个用例独立启动/停止 gateway 的方式通过。
2. **`dsh.home` 未生效**：`serve` 时没有把 `config.dsh.home` 注入子进程 `DSH_HOME`，
   已由 Lead 修复（`createBridge` 的 `env` 合并 `DSH_HOME`）。
3. **契约与实现的回复语义**：`reply.maxChunks`（默认 6）与空回复 `reply.emptyText`
   已按实现更新到 `docs/contracts.md`，本组文档按实现编写。
4. **工作区作用域防串项目**：`sessions.json` 记录工作区指纹（cwd/dshHome），
   同一 stateDir 被另一个工作区复用时丢弃旧绑定并告警；`status`/`doctor`/`serve` 均显示工作区。
   已加 3 个工作区指纹单测；另加工作区本地配置优先级 + `init --local`/`pair` e2e。公众号渠道移除后
   渠道集合变为四渠道（当前全量 661，见 §1）。会话仍按 IM 会话独立，不跨工作区复用。
5. **DSH 宿主插件入口**：`package.json` main 原来只导出库 API，loader 挂载时没有
   `apply/name/inject`，表现为 "did not activate"。已让 main 暴露插件面并懒加载
   `src/dsh-plugin.js`，并用 `install/verify-plugin.sh` 在真实 loader 下验证通过。
6. **pairing 跨进程生效**：CLI `pair`/`allow` 与常驻网关是不同进程，网关原先只在启动时读
   一次 `pairing.json`，批准后必须重启才生效。已改为按文件 mtime 自动重载，并加了
   gateway/core 单测（不重启即可放行）。
7. **v1.1 新建工作区渠道默认 disabled**：`addWorkspace` 不再按勾选自动 `enabled:true`，
   改为创建后由渠道卡片启用（飞书/微信扫码、钉钉/企微保存配置）。e2e 已覆盖
   addWorkspace→connect→confirmed 的配置变化；旧工作区配置不受影响。
8. **B 方案：host plugin 内嵌 manager + 单实例锁**：新增 `mode: manager`、`src/host/*`
   （嵌入 manager / lock / HTTP client）与 `activate.sh` 默认 manager 行；CLI manager 与 host plugin
   共用 `manager.lock`，第二个 owner 不再启动（插件 attach、CLI 提示已在运行），避免重复起 manager
   抢渠道/端口。已由 `test/host/*`（14）、`embedded-manager.e2e`（2）和隔离 profile 验证覆盖。
9. **manager/headless 工具审批补丁冲突**：真实 manager 联调时 headless 审批 patch 与
   permission-presets 冲突，日志报 `composed sandbox and approval defaults match no preset`。
   已扩展 `sdk-patch.yml` 增加 `workspace-write-auto` preset + `defaultPreset`，重启后不再告警
   （属运行环境补丁，不在本仓库 `src/` 内）。

## 9. 未验证 / 风险清单

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| 未真机联调 | 除微信个人（§7.5 已真实扫码联调）外，飞书/钉钉/企业微信没有真实凭证与公网联调，平台交互为本地 mock | 上线前用测试号/测试企业逐渠道跑一次真实收发 |
| 微信（个人）真实扫码 | 未用真实微信号执行 `weixin login`；二维码/数字验证码/手机确认无法自动化 | 用测试微信号扫码跑通登录→收发→掉线重登 |
| 微信（个人）真实 iLink 服务端 | 协议实现基于官方文档与 fake 后端验证，未与腾讯线上 iLink 服务端联调；-14/风控/IDC redirect 为模拟 | 真实登录后观察 getupdates/sendmessage 与断线重连 |
| 微信（个人）多账号 | 一个 `channels.weixin` 只对应一个机器人账号，未验证同实例多账号/多机器人 | v1 不支持；需要多账号时拆多个 gateway 实例 |
| 微信（个人）媒体 | 入站图片/文件/视频/语音已下载 + AES 解密（单测覆盖），但**未用真实账号复测媒体下载**；出站媒体 v1 不支持 | 用真实微信号发图片/文件验证落盘与 Agent 可见性；不要承诺出站媒体 |
| 长连接模式 | 飞书 `ws`、钉钉 `stream`、企业微信 `ws` 的 e2e 未跑；仅有 adapter 单测（fake WS/stream） | 用真实企业应用验证长连接建立、断线重连、被踢下线 |
| 真实模型轮次 | 已用 `deepseek-account` 复用桌面登录在真实工作区跑通一轮（§3）；工具审批/超时路径仍以 fake runtime 覆盖 | 在 IM 端真机再跑几轮含工具调用的对话 |
| 加密/安全模式 | 飞书 `encryptKey`、企业微信解密在 e2e 只覆盖了企微；飞书加密仅有单测 | 平台后台开启安全模式后再跑一轮 |
| 群聊 @ 判定 | e2e 只覆盖「未 @ → 丢弃」；@ 命中路径依赖 adapter 单测 | 在真实群里 @ 机器人验证 |
| 附件 | 微信个人入站媒体已下载解密；其余渠道仍以 URL/路径提示为主；所有渠道出站媒体均不支持（`media: false`） | 明确告知用户 v1 不转发媒体内容 |
| 平台限额 | 钉钉 sessionWebhook 过期、企微主动推送额度未压测 | 控制 `reply.maxChunks`，必要时改用长连接回复 |
| 并发/长稳 | e2e 使用 `concurrency=2`；未做高并发、内存增长、长稳测试 | 压测 + 观察 stateDir 增长（dedupe 上限 5000） |
| manager 浏览器人工操作 | Lead 用 Tabbit 验证了双工作区渲染；完整人工点击流程（逐项编辑保存、删除确认、日志滚动、多轮操作）未由自动化覆盖 | 发布前按 [manager.md](manager.md) §5 走一遍全流程 |
| manager 安全 | 只监听 loopback、无鉴权/TLS/多用户；未验证反代+鉴权后的远程访问 | 不要把 8788 暴露公网；远程访问必须自加 TLS+鉴权 |
| manager 多真实渠道 | 真机只验证了 `dsh`（微信个人真实登录）与 `demo-feishu`（演示用假 appId/secret）两个工作区；未验证多个真实渠道账号并行/长稳 | 用真实渠道账号跑多工作区 24h 观察 |
| manager 渠道账号抢占 | 同一渠道账号跨工作区并发只靠文档约束，无占用锁/检测；未做自动化测试 | 每个工作区使用独立账号；必要时在配置评审里检查 |
| manager 长稳/资源 | 每个工作区一个 DSH runtime 子进程；未测多工作区内存/CPU 与长时间运行 | 观测 RSS，限制工作区数量，必要时分机部署 |
| 渠道扫码真实确认 | QR 生成/取消/状态机已实测，但**未用真实手机扫码并在手机上确认**（微信登录 confirm / 飞书 registerApp 确认） | 用手机真实扫码走通 weixin/feishu 的 confirmed 分支 |
| 飞书扫码创建应用 | 扫码创建出的飞书应用未验证机器人/消息权限与发布状态，真实 bot 收发未验证 | 扫码后到飞书后台补权限、发布版本，再发消息验证 |
| 取消后二维码失效 | cancel 只保证本地 flow cancelled + 渠道 disabled；二维码在微信/飞书平台侧的失效时间未验证 | 不依赖“取消即失效”，必要时在平台侧确认 |
| manager UI 扫码人工流程 | 仅抽查微信二维码弹窗、飞书双 tab/手动表单、关闭取消；完整多轮操作未自动化 | 发布前按 [manager.md](manager.md) §6 人工走查 |
| 升级兼容（公众号移除） | 旧配置里的 `channels.wechat` 会被当作未知渠道报错，需要手动删除 | 升级前检查并移除 `channels.wechat` 段 |
| host plugin 长期运行/升级 | 真实 `desktop` profile 已安装并完成 owned + `im_gateway_status` 工具验证（2026-10-18），但尚未覆盖 DSH 升级、插件重复安装/卸载、长时间运行与热重载回归 | 升级 DSH 后重跑 `install/verify-plugin.sh`；用 `manager.lock` 与 `/api/health` 确认 owner |
| D client-plugin 页面 | 仍是后续工作，当前 UI 只有 `http://127.0.0.1:8788/` 网页 | 不要向用户承诺 DSH Desktop 内嵌管理页 |
| DSH 版本耦合 | host plugin 依赖 DSH loader 的 patch 层/in-box 包（`@deepseek-ai/dsh-tools`、schemastery）与 profile 布局；DSH 升级可能破坏 patch 行或插件加载 | 升级 DSH 前在隔离 profile 跑 `install/verify-plugin.sh`；保留 patch 备份 |
| host 进程信任边界 | 插件在 DSH 宿主进程内运行 manager，可读写管理器与工作区配置/凭据；manager HTTP 仅 loopback 无鉴权 | 视为高权限组件；不要装来路不明的改版包，不要把 8788 暴露公网 |
| 插件热重载中断 | `activate.sh`/patch watcher 热重载会 dispose 内嵌 manager，工作区短暂中断 | 安装/升级选空闲时间；升级后重启工作区并确认渠道 connected |
| 全量测试偶发 | 改装 host plugin 后首次全量运行出现过 1 次未复现失败；随后连续 4 次 640/640（疑似与本机 8788 常驻 manager/端口探测时序相关） | CI 复跑 3 次；关注 `test/host`/embedded-manager 用例是否再次偶发 |
| 常驻脚本 | launchd/systemd 示例未实机加载 | 部署时先 `doctor`，再观察首日日志 |
| TLS / 反向代理 | webhook 不内置 TLS，反代与来源限制未验证 | 用 Caddy/Nginx 终止 TLS 并限制来源 IP |
| Node 版本 | 只测了 Node 24.20.0；`engines` 要求 >=22.19 | CI 增加 22.x/24.x 矩阵 |
