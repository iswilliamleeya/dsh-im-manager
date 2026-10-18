# Manager + Web UI 契约（v1, frozen）

目标：一个 manager 进程管理多个**工作区**，每个工作区独立绑定不同的 IM channel，并提供一个本地
Web UI 做增删改查、启停、看状态、批准配对。工作区模型不变：**一个工作区 = 一个 gateway 实例 =
一个 DSH SDK runtime = 一套渠道账号**。

```
浏览器 ──HTTP──▶ manager (127.0.0.1:8788)
                   ├── workspace A (gateway → dsh runtime, channels: feishu)
                   ├── workspace B (gateway → dsh runtime, channels: dingtalk)
                   └── workspace C (gateway → dsh runtime, channels: weixin)
```

## 1. 文件与目录

- manager 配置：`<managerFile>`（默认 `~/.dsh-im-manager/manager.json`）
  ```json
  {
    "version": 1,
    "listen": { "host": "127.0.0.1", "port": 8788 },
    "workspaces": [
      {
        "id": "dsh",
        "name": "DSH workspace",
        "workspaceDir": "/Users/williamlee/Documents/DSH",
        "configFile": "/Users/williamlee/Documents/DSH/.dsh-im-manager/config.json",
        "autoStart": false
      }
    ]
  }
  ```
- 每个工作区仍然使用普通的 gateway 配置（格式见 `docs/contracts.md` / `docs/configuration.md`）。
  新建工作区时默认写 `<workspaceDir>/.dsh-im-manager/config.json`，其中：
  - `dsh.cwd = workspaceDir`
  - `gateway.stateDir = <managerDataDir>/workspaces/<id>/state`（`managerDataDir` 默认 `~/.dsh-im-manager`）
  - `gateway.http.port = 0`（避免多个工作区抢端口；webhook 模式也能用，UI 展示实际端口）
  - `channels.*.enabled` 按创建时选择绑定；未选中的渠道保持默认（关闭）
- 工作区 id：小写字母/数字/`-`，唯一；默认由 name slug 生成。
- 配置文件写入必须 0600、原子写。

## 2. Manager 模块接口（`src/manager/manager.js`）

```js
createManager({ managerFile?, managerDataDir?, logger?, gatewayFactory?, now? })
  // gatewayFactory({ config, logger }) -> gateway（默认 core createGateway），测试注入 fake
→ {
  async init(),                         // 读 manager.json；不存在则用默认（当前工作区可后续添加）
  async start(),                        // 启动所有 autoStart 工作区（失败不阻塞其它）
  async stop(),                         // 停止全部 + 关闭（幂等）
  getState(),                           // 见 §3（同步、可直接 JSON）
  async addWorkspace({ name, workspaceDir, channels?, autoStart? }), // → workspace 摘要
  async updateWorkspace(id, { name?, autoStart? }),
  async removeWorkspace(id),            // 先 stop
  async startWorkspace(id), stopWorkspace(id), restartWorkspace(id),
  getWorkspaceConfig(id),               // 脱敏后的配置对象（§4）
  async saveWorkspaceConfig(id, config),// 校验 → 写文件 → 若运行中则重启
  listPairing(id),                      // [{ code, channel, senderId, name, expiresAt }]
  async approvePairing(id, code),       // → { ok:true, channel, senderId } | 抛错
  getLogs(id, lines = 200),             // 最近的 gateway 日志行（字符串数组，脱敏）
  get listen(),                         // { host, port } 实际监听端口
}
```

- 每个工作区一个 `createGateway` 实例；manager 捕获其 logger 到环形缓冲（默认 500 行/工作区）。
- 启动失败（配置错误/端口占用/渠道失败）→ 该工作区 `state='error'` 且 `error` 有脱敏原因，
  其它工作区不受影响。gateway 内部单渠道失败仍由 gateway 自己降级（state 仍 running）。
- manager 构造时不做 I/O；`init()` 才读文件。`start()` 幂等。

## 3. 状态形状（`getState()` / `GET /api/state`）

```json
{
  "manager": { "pid": 123, "listen": { "host": "127.0.0.1", "port": 8788 }, "startedAt": 0, "workspaceCount": 2 },
  "workspaces": [
    {
      "id": "dsh",
      "name": "DSH workspace",
      "workspaceDir": "/Users/williamlee/Documents/DSH",
      "configFile": "/Users/williamlee/Documents/DSH/.dsh-im-manager/config.json",
      "autoStart": false,
      "state": "running",
      "error": null,
      "workspaceCwd": "/Users/williamlee/Documents/DSH",
      "bridge": "ready",
      "sessions": 1,
      "channels": [
        { "id": "weixin", "enabled": true, "mode": "ilink", "health": "connected", "detail": "ilinkBotId: …" }
      ],
      "pendingPairings": [
        { "code": "123456", "channel": "weixin", "senderId": "…", "name": null, "expiresAt": 0 }
      ],
      "http": { "port": 0, "publicBaseUrl": "http://127.0.0.1:12345" }
    }
  ]
}
```

- `state`: `stopped | starting | running | stopping | error`
- `bridge`: `absent | starting | ready | restarting | stopped`
- `channels[].enabled` 来自配置文件；`health` 来自运行中的 adapter（未运行时为空）。
- 状态必须**可 JSON 序列化**，不含函数/路径外的敏感值。

## 4. 配置脱敏（`getWorkspaceConfig`）

返回与配置文件同构的对象，但把以下字段的值替换为 `"***"`（若是 `env:NAME` / `${NAME}` 则原样保留）：

`appSecret`, `clientSecret`, `secret`, `token`, `encodingAESKey`, `encryptKey`,
`verificationToken`, `password`, `apiKey` 及 `dsh.env` 中 name 匹配 `SECRET|TOKEN|KEY|PASSWORD` 的值。

`saveWorkspaceConfig` 收到含 `"***"` 的字段时：保留原文件中的值（前端未改密钥就原样回写）。

## 5. HTTP API（`src/manager/api.js`）

- 监听 `manager.listen`（默认 127.0.0.1:8788；只允许本机，不做公网认证）。
- 全部 JSON；请求体上限 2 MiB；响应错误 `{ "error": { "message": "..." } }`，4xx/5xx。
- 静态 UI：`GET /`、`GET /app.js`、`GET /style.css` 从 `src/webui/` 读；路径穿越拒绝。
- 端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 状态（§3） |
| POST | `/api/workspaces` | `{name, workspaceDir, channels?: string[], autoStart?}` |
| PATCH | `/api/workspaces/:id` | `{name?, autoStart?}` |
| DELETE | `/api/workspaces/:id` | 先 stop 再移除 |
| POST | `/api/workspaces/:id/start` | 启动 |
| POST | `/api/workspaces/:id/stop` | 停止 |
| POST | `/api/workspaces/:id/restart` | 重启 |
| GET | `/api/workspaces/:id/config` | 脱敏配置 |
| PUT | `/api/workspaces/:id/config` | 保存配置（校验后写盘；运行中自动重启） |
| GET | `/api/workspaces/:id/pairing` | 待配对列表 |
| POST | `/api/workspaces/:id/pairing/approve` | `{code}` 批准 |
| GET | `/api/workspaces/:id/logs?lines=200` | 最近日志 |
| GET | `/api/health` | `{ok:true}`（UI 探活） |

- `POST /api/workspaces` 的 `channels` 是渠道 id 数组（`feishu|dingtalk|wecom|weixin`）；
  创建后对应 `channels.<id>.enabled=true`，其余关闭。
- `PUT config` 用 `validate()` + 各 adapter 的 `validateConfig()` 校验；失败返回 400 且不写盘。
- 所有写操作串行化（manager 内部互斥），避免并发保存/启动竞争。

## 6. Web UI（`src/webui/`）

无构建步骤的静态三件套：`index.html` + `app.js` + `style.css`（ES module、原生 fetch）。

- 左侧工作区列表：名称、状态点（running/stopped/error）、渠道 chips、添加工作区按钮。
- 右侧详情：
  - 头部：名称、workspaceDir、configFile、开始/停止/重启按钮；
  - 渠道卡片：4 个渠道的启用开关 + 关键字段（`appId/appSecret/...`，密钥输入框 type=password，
    已有值显示 `***` 占位，不回显明文）；保存按钮；
  - 配对面板：待配对码 + 批准按钮；
  - 日志面板：最近 200 行，刷新按钮；
  - 微信状态：未登录提示（v1 登录仍用 CLI `weixin login`，UI 只展示状态）。
- 轮询 `/api/state` 每 2s；操作后立即刷新；错误在页面顶部 toast。
- 不引入前端框架、不做登录认证（监听 127.0.0.1；如需远程，用户自行反代 + 鉴权）。

## 7. CLI

```bash
dsh-im-manager manager [--config <manager.json>] [--port 8788] [--no-open]
```

- 启动 manager（前台常驻），打印 Web UI URL；SIGINT/SIGTERM 停止全部工作区并退出。
- `--no-open` 默认行为就是只打印 URL，不拉起浏览器。
- `manager init [--config]` 可选：写一个含当前工作区的 manager.json；v1 可省略。

## 8. 测试约定

- `test/manager/*.test.js`（manager-dev）：config store CRUD/脱敏/0600、生命周期（fake gateway）、
  start/stop 幂等、单工作区失败隔离、配对审批、日志环形缓冲。
- `test/webui/*.test.js`（webui-dev）：静态路由 + 404/穿越拒绝、API 客户端纯函数（可选）。
- Lead：manager e2e（真实 gateway + fake DSH runtime 两工作区）与 CLI smoke；更新 README/verification。
- 所有测试用 `node:test`，不新增 npm 依赖。

## 9. v1 不做

- UI 内微信扫码登录（仍用 CLI；后续可加 QR API）
- Web UI 鉴权/TLS（只监听 loopback）
- 多用户/权限系统
- 把 manager 嵌进 DSH Desktop 的 client plugin（独立网页；后续可做）
- 同一渠道账号在多个工作区并发绑定（会互相抢占长连接；UI 只展示/保存配置，不做账号占用锁）

## 10. 渠道扫码连接（v1.1，UI 弹窗）

除 `dingtalk` / `wecom`（直接保存配置并启用）外，`weixin` 与 `feishu` 支持在 UI 里扫码连接。
**规则：扫码弹窗在确认前关闭 = 该渠道不启用。** 只有扫码确认成功才写 `enabled:true`。

### 10.1 创建的工作区默认不启用渠道

`POST /api/workspaces` 的 `channels` 参数只表示“为这些渠道创建配置块”，所有渠道都写为
`enabled:false`。启用动作统一走 UI 的渠道卡片（二维码或手动配置），不再在创建时自动启用。

### 10.2 连接流程状态机

```
begin → pending(qr) → scanned → confirmed
                 ↘ expired / failed / cancelled
```

- `pending`：二维码已生成，等待扫码；`scanned`：已扫码等待手机确认（weixin/feishu 能区分时）；
- `confirmed`：凭据已写入、渠道 `enabled:true`、工作区若在运行则已重启；
- `expired`：二维码/device code 过期；渠道保持 `enabled:false`；
- `cancelled`：用户关闭弹窗或显式取消；渠道保持 `enabled:false`；
- `failed`：网络/协议错误；渠道保持 `enabled:false`，`error` 为脱敏消息。
- 每个 workspace+channel 同时最多一个 flow；`begin` 会取消旧 flow。
- flow 终止后状态保留 10 分钟供 UI 查询；之后可重新 begin。

### 10.3 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/workspaces/:id/channels/:channel/connect` | body `{ mode?: "qr" }`；支持 `weixin`、`feishu`；返回 flow |
| GET | `/api/workspaces/:id/channels/:channel/connect` | 当前/最近 flow 状态 |
| POST | `/api/workspaces/:id/channels/:channel/connect/cancel` | 取消 flow；确保 `enabled:false` |

返回 flow：
```json
{
  "flowId": "…",
  "channel": "weixin",
  "state": "pending",
  "qr": { "dataUrl": "data:image/png;base64,…", "expiresAt": 0 },
  "intervalMs": 1500,
  "error": null,
  "result": null,
  "updatedAt": 0
}
```
- `qr.dataUrl` 是服务端用 `qrcode` 生成的 PNG data URL（640×640），前端直接 `<img>`；
  weixin/feishu 的二维码内容都由 provider 回调提供，扫同一状态可多次刷新 QR（`begin` 重新调用）。
- `result` 仅成功时返回脱敏摘要：weixin `{ ilinkBotId, userId? }`；feishu `{ appId, domain }`。
- 错误码：400 不支持的渠道/mode；404 workspace；409 渠道已启用（先停用再重连）。

### 10.4 Provider 接口（便于测试注入）

`createChannelConnectProviders({ registerApp?, runWeixinLogin?, qrcode? })` 返回：
```js
{
  weixin: {
    async begin({ workspace, channelConfig, stateDir, onQr, onStatus, signal }) // → { ilinkBotId, userId? }
  },
  feishu: {
    async begin({ workspace, channelConfig, onQr, onStatus, signal }) // → { appId, domain }
  }
}
```
- provider 负责协议与凭据写入（weixin 写 `<stateDir>/credentials.json`；feishu 返回 appId/appSecret 由 manager 写入配置）；
- `onQr({ content, expiresAt })`：content 是二维码编码内容（URL 或字符串）；
- `onStatus({ state: 'pending'|'scanned', detail? })`；
- `signal` abort 时 provider 必须尽快 reject；
- 失败抛错（脱敏）。
- manager 在收到成功结果后：写配置（weixin `enabled:true`；feishu `{ enabled:true, appId, appSecret, domain }`）、
  若工作区 running 则 `restartWorkspace`。

### 10.5 飞书手动模式

手动填 `appId` / `appSecret` 不走 connect flow：UI 复用
`GET/PUT /api/workspaces/:id/config`，把 `channels.feishu.enabled=true` + 两个密钥写回即可；
保存会校验并重启工作区。扫码模式与手动模式互斥，由 UI 的 tab 选择。

### 10.6 UI 要求

- 飞书卡片点“启用”→ 弹窗，两个 tab：**扫码创建/登录**（默认）与**手动填写 App ID/Secret**。
- 微信卡片点“启用”→ 弹窗只显示二维码（无手动模式）。
- 弹窗关闭（X / Esc / 点遮罩 / 取消）时，若尚未 `confirmed`，必须调用 cancel，
  渠道保持未启用；不能先乐观地打开开关。
- 弹窗内轮询 `GET .../connect`；`expired`/`failed` 显示“重新生成二维码”；`confirmed` 显示成功并刷新。
- 手动飞书保存成功等价于启用；失败 toast。
- 其它渠道（dingtalk/wecom）保持现有“保存配置即启用”的行为。
