# 多工作区管理（DSH 原生页面）

> 状态：v1。契约以 [manager-contract.md](manager-contract.md) 为准；本文是使用与运维视角的说明。
> 实现：`src/manager/`（manager + 本机 HTTP API）、`lib/client.js`（DSH 侧栏「消息」页面）。
> Web UI 静态页面与独立 CLI manager 已移除。

## 1. 定位与架构

manager 内嵌在 DSH 宿主进程里，管理**多个工作区**（每个工作区一份 gateway 配置、一套渠道账号、
一个 DSH runtime）：

```
DSH 侧栏「消息」 ──同源 RPC /im-manager──▶ host plugin/manager
                                             ├── workspace A：gateway → dsh runtime（飞书）
                                             ├── workspace B：gateway → dsh runtime（钉钉）
                                             └── workspace C：gateway → dsh runtime（微信个人）
```

manager 的本机 HTTP API（`127.0.0.1:8788`）仍保留，用于 attach 模式与健康检查；
它**不再提供浏览器 UI**，`GET /` 只返回服务信息。

不变式（v1 不变）：

- **一个工作区 = 一个 gateway 实例 = 一个 DSH SDK runtime 子进程 = 一套渠道账号**；
- 每个工作区使用**普通 gateway 配置**（格式见 [configuration.md](configuration.md)），manager 不改变渠道字段；
- 工作区之间相互隔离：一个工作区启动失败只标记它自己 `state=error`，不影响其它工作区；
- `manager.json` 只记录「有哪些工作区、HTTP API 监听在哪」，不存渠道密钥（密钥仍在各工作区配置里）。

manager 数据目录默认 `~/.dsh-im-manager`（可用 manager API/CLI 的 `--config` 指向别的 `manager.json`，
但数据目录本身没有 CLI 参数，默认固定）。

## 2. 启用

```bash
# 作为 profile bundle 安装（推荐）
dsh plugin --profile desktop add github:iswilliamleeya/dsh-im-manager

# 开发态：直接写 desktop profile
bash install/activate.sh
```

重启 DSH 后打开左侧栏「消息」：

1. 「DSH 工作区」列出当前 profile 的所有 workspace；
2. 选中没有 Gateway 的工作区 →「创建 Gateway」（幂等 adopt，生成 `<workspace>/.dsh-im-manager/config.json`）；
3. 渠道行里扫码/填配置启用渠道；
4. 需要随 DSH 自动恢复时打开「自动启动」。

不再有独立 CLI `manager` / `serve` / `init`；`dsh-im-manager doctor|status|pair|weixin...`
仅作诊断与终端操作。

## 3. `manager.json`

默认路径：`~/.dsh-im-manager/manager.json`，权限 `0600`、原子写。首次启动自动创建：

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 8788 },
  "workspaces": [
    {
      "id": "dsh",
      "name": "DSH",
      "workspaceDir": "/Users/you/Documents/DSH",
      "configFile": "/Users/you/Documents/DSH/.dsh-im-manager/config.json",
      "autoStart": false
    }
  ]
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | number | `1` | 当前只有 1 |
| `listen.host` | string | `"127.0.0.1"` | manager HTTP API 监听地址；**只建议 loopback** |
| `listen.port` | number | `8788` | 监听端口 |
| `workspaces[].id` | string | 由名称生成 | 小写字母/数字/`-`，全局唯一；删除后同名可复用 |
| `workspaces[].name` | string | 必填 | 显示名 |
| `workspaces[].workspaceDir` | string | 必填 | 工作目录（`dsh.cwd`），不存在会创建 |
| `workspaces[].configFile` | string | `<workspaceDir>/.dsh-im-manager/config.json` | 该工作区的 gateway 配置路径 |
| `workspaces[].autoStart` | boolean | `false` | manager 启动时是否自动启动该工作区 |

说明：

- 手工改 `manager.json` 后需要**重启 manager** 才生效（运行中不会热加载）；
- 删除工作区（页面/API）**只从 manager.json 移除条目**，不删除配置文件、`stateDir`、微信凭据与会话，
  这样误删可以恢复；
- 工作区 id 由名称 slug 化生成（如 `Demo Feishu` → `demo-feishu`），重复时自动加后缀。

## 4. 工作区配置与目录布局

页面新建工作区时会生成一份普通 gateway 配置（`0600`）：

| 配置项 | 生成值 |
| --- | --- |
| `dsh.cwd` | 工作区的 `workspaceDir` |
| `gateway.stateDir` | `<managerDataDir>/workspaces/<id>/state`（默认 `~/.dsh-im-manager/workspaces/<id>/state`） |
| `gateway.http.port` | `0`（随机端口，避免多个工作区抢 8788/8787；页面详情里显示实际端口） |
| `channels.*` | **全部 `enabled: false`**；创建时的渠道勾选只决定页面展示，不负责启用 |
| 其他字段 | 取 `defaultConfig()` 默认值，之后可在页面/配置文件中改 |

要点：

- **v1.1 起新建工作区不会自动启用任何渠道**（契约 §10.1）：启用统一走渠道卡片的扫码连接
  （飞书/微信）或保存配置（钉钉/企业微信），详见 §6；
- **manager 不改变 gateway 配置格式**：每个工作区仍是 [configuration.md](configuration.md) 描述的那份 JSON；
  也可以继续用 `doctor`、`pair`、`sessions` 等诊断命令按工作区操作（`cd <workspace>`）；
- 已有工作区配置（例如手工创建、带固定端口 `8787` 的配置）会**原样使用**，不会被改写成 `port=0`；
- 多个工作区默认各自随机 HTTP 端口；webhook 渠道（飞书/钉钉/企业微信）需要把平台回调分别指向
  各工作区的实际端口（或统一反代到不同路径/域名）；
- 渠道密钥可以继续用 `env:NAME` / `${NAME}` 占位——**在 manager 进程的环境变量里解析**，
  所以 DSH 宿主启动环境里要包含这些变量；
- 工作区配置文件里的 `getWorkspaceConfig` 返回值会把密钥替换成 `***`（`env:`/`${}` 原样保留），
  保存时含 `***` 的字段保留旧值；
- 一个渠道账号（尤其长连接/扫码登录类：飞书 ws、钉钉 stream、企业微信 ws、微信个人）**不要同时绑定到多个工作区**，
  否则会互相抢占长连接/互相踢下线。

## 6. 渠道扫码连接（weixin / feishu）

`weixin` 与 `feishu` 可以在 DSH「消息」页面里通过扫码完成「连接并启用」；钉钉/企业微信仍为
「保存配置即启用」。核心规则：**扫码弹窗在确认前关闭 = 渠道不启用**。

### 6.1 创建的工作区默认不启用渠道

`POST /api/workspaces` 的 `channels` 参数只表示「为这些渠道创建/展示配置块」，所有渠道都写
`enabled:false`。启用动作统一走渠道卡片（扫码或手动配置），不再在创建时自动启用。

### 6.2 状态机

```
begin → pending(二维码) → scanned（已扫码等待确认）→ confirmed
                ↘ expired / failed / cancelled
```

| 状态 | 含义 | 渠道 `enabled` |
| --- | --- | --- |
| `pending` | 二维码已生成，等待扫码 | `false` |
| `scanned` | 已扫码，等待手机端确认（provider 能区分时） | `false` |
| `confirmed` | 凭据已写入配置、`enabled:true`；工作区若在运行已重启 | `true` |
| `expired` | 二维码/设备码过期 | `false` |
| `failed` | 网络/协议错误，`error` 为脱敏消息 | `false` |
| `cancelled` | 用户关闭弹窗或显式取消 | `false` |

- 每个 `workspace + channel` 同时最多一个 flow；再次 `begin` 会取消旧 flow；
- 终止状态（confirmed/expired/failed/cancelled）保留 **10 分钟**供页面查询，之后可重新 begin；
- 只有 `confirmed` 会写 `enabled:true` 并（运行中时）重启工作区。

### 6.3 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/workspaces/:id/channels/:channel/connect` | body `{ mode?: "qr" }`；仅 `weixin`/`feishu`；返回 flow（等首个二维码，≤1.5s） |
| GET | `/api/workspaces/:id/channels/:channel/connect` | 查询当前/最近 flow（终止 flow 保留 10 分钟；无 flow 时 404） |
| POST | `/api/workspaces/:id/channels/:channel/connect/cancel` | 取消 flow 并确保 `enabled:false` |

返回的 flow：

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

- `qr.dataUrl`：服务端用 `qrcode` 生成的 **640×640 PNG data URL**，前端直接渲染 `<img>`；
  二维码内容由 provider（微信 iLink / 飞书设备码）提供，`GET` 轮询可看到状态变化；
- `result` 只在 `confirmed` 时返回脱敏摘要：weixin `{ ilinkBotId, userId? }`；
  feishu `{ appId, domain }`。**任何密钥都不会出现在 flow 里**，飞书 appSecret 只写进 0600 配置文件；
- 错误码：`400` 不支持的渠道/mode；`404` workspace 不存在（或 GET 无 flow）；`409` 渠道已启用
  （先停用/关闭再重连）。

### 6.4 飞书手动模式

飞书弹窗的「手动填写」tab 不走向导：读取当前配置，提交时复用
`PUT /api/workspaces/:id/config` 写入 `channels.feishu.enabled=true` + `appId`/`appSecret`/`domain`
（`***` 保留旧密钥），保存会校验并重启工作区。手动与扫码互斥，由 tab 选择；切换到手动 tab 会取消
正在进行的扫码 flow。

### 6.5 微信与飞书扫码的差异

- **微信（个人）**：弹窗只有二维码；扫码确认后 `runWeixinLogin` 把凭据写到
  `<gateway.stateDir>/channels/weixin/credentials.json`（`0600`），manager 只把
  `channels.weixin.enabled` 改为 `true`（配置里不出现 token）；
- **飞书**：扫码走官方设备码应用注册（`registerApp`）；成功后 manager 把 `appId`/`appSecret`/`domain`
  写进工作区配置并 `enabled:true`。若该飞书应用缺少机器人/消息权限，扫码可能成功但真实收发仍需在
  飞书后台补权限；
- 两者都支持在弹窗里「重新生成二维码」（`expired`/`failed` 后），关闭弹窗即取消。

## 7. HTTP API

只监听 `manager.listen`（默认 `127.0.0.1:8788`）。请求/响应均为 JSON；请求体上限 2 MiB；
错误响应 `{ "error": { "message": "..." } }`，状态码 4xx/5xx。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true }`，探活 |
| GET | `/api/state` | 管理器与全部工作区状态（返回前会刷新一次各工作区 status） |
| POST | `/api/workspaces` | `{ name, workspaceDir, channels?: string[], autoStart? }`，创建并写工作区配置 |
| PATCH | `/api/workspaces/:id` | `{ name?, autoStart? }` |
| DELETE | `/api/workspaces/:id` | 先 stop，再从 manager.json 移除（磁盘文件保留） |
| POST | `/api/workspaces/:id/start` | 启动工作区（幂等） |
| POST | `/api/workspaces/:id/stop` | 停止工作区（幂等） |
| POST | `/api/workspaces/:id/restart` | 重启工作区 |
| GET | `/api/workspaces/:id/config` | 脱敏配置（密钥 → `***`，`env:`/`${}` 保留） |
| PUT | `/api/workspaces/:id/config` | 保存配置：校验 → 原子写 → 若运行中自动重启；含 `***` 的字段保留旧值 |
| POST | `/api/workspaces/:id/channels/:channel/connect` | 开始扫码连接（仅 weixin/feishu，`{mode:"qr"}`），返回 flow（§6.3） |
| GET | `/api/workspaces/:id/channels/:channel/connect` | 查询当前/最近 connect flow（无 flow 时 404） |
| POST | `/api/workspaces/:id/channels/:channel/connect/cancel` | 取消 flow，确保渠道 `enabled:false` |
| GET | `/api/workspaces/:id/pairing` | `{ pending: [...] }` 待配对列表（`pendingPairings` 同内容） |
| POST | `/api/workspaces/:id/pairing/approve` | `{ code }`，批准配对 |
| GET | `/api/workspaces/:id/logs?lines=200` | `{ lines: string[] }`，最近日志（脱敏） |
| GET | `/` | 服务信息 `{ ok, service, ui, health }`；不再提供静态页面 |

- `channels` 取值：`feishu`、`dingtalk`、`wecom`、`weixin`（与 [channels/index.md](channels/index.md) 一致）。
- `GET /api/state` 每次会触发一次工作区状态刷新；DSH 页面 2.5s 轮询 `discover` 也承担「保持状态新鲜」的职责。
- 所有写操作在 manager 内部串行化（互斥），避免并发启动/保存竞争。
- 非 API 路径一律 JSON 404；没有静态资源。

状态形状（`GET /api/state`）：

```json
{
  "manager": { "pid": 123, "listen": { "host": "127.0.0.1", "port": 8788 }, "startedAt": 0, "workspaceCount": 2 },
  "workspaces": [
    {
      "id": "dsh",
      "name": "DSH",
      "workspaceDir": "/Users/you/Documents/DSH",
      "configFile": "/Users/you/Documents/DSH/.dsh-im-manager/config.json",
      "autoStart": false,
      "state": "running",
      "error": null,
      "workspaceCwd": "/Users/you/Documents/DSH",
      "bridge": "ready",
      "sessions": 1,
      "channels": [
        { "id": "weixin", "enabled": true, "mode": "ilink", "health": "connected", "detail": "ilinkBotId: …" }
      ],
      "pendingPairings": [],
      "http": { "port": 8787, "publicBaseUrl": "http://127.0.0.1:8787" }
    }
  ]
}
```

## 8. 安全

- **只监听 loopback**（默认 `127.0.0.1:8788`），**没有登录/鉴权，也没有 TLS**。
- 不要直接暴露 8788 到公网。确需远程访问时，自行用反向代理 + 强鉴权 + TLS，并且只暴露必要路径。
- 配置 API 返回的密钥一律 `***`；日志行经过脱敏（Bearer、query 里的 token、secret 字段等）。
- `manager.json` 与各工作区配置都是 `0600`，原子写；页面的错误信息也做了脱敏。
- 「批准配对」= 把陌生人加入该工作区 allowlist，属于特权操作；不要在共享浏览器/录屏环境里操作。
- 同一渠道账号不要跨工作区并发绑定（会互相抢占长连接）；微信个人凭据文件仍按工作区隔离。
- 删除工作区不删磁盘文件；要彻底清理需手动删除对应 `configFile` 与 `stateDir`（含微信凭据/会话映射）。

## 9. 生命周期

- manager 由 DSH 宿主创建：启动 HTTP API → 启动所有 `autoStart=true` 工作区（单个失败只记录 error，
  不阻塞其它）→ DSH 退出/卸载插件时停止全部工作区并关闭 API。
- 工作区状态：`stopped | starting | running | stopping | error`；失败原因在 `error` 与日志里。
- `start/stop/restart` 幂等；`PUT config` 保存后若该工作区在运行会自动重启它。
- manager 重启后**只有 `autoStart=true` 的工作区会自动启动**；其余保持 stopped，可在页面点开始。
- 单实例锁 `~/.dsh-im-manager/manager.lock`：已有 live manager 时插件 attach 到它的 HTTP API，
  不重复启动、不抢渠道；只有 owner 负责停止。

## 10. 作为 DSH 宿主插件（mode=manager）

manager 作为 **DSH host plugin** 加载：DSH 启动时在宿主进程内创建 manager（本机 HTTP API）
并启动工作区；DSH 退出/卸载插件时停止。没有独立 CLI manager 进程。

### 10.1 运行形态

| | DSH host plugin（mode=manager） |
| --- | --- |
| 启动方式 | `dsh plugin add ...` 或 `bash install/activate.sh`，随 DSH 启动 |
| 生命周期 | 随 DSH 宿主 apply/dispose |
| 适合 | 桌面 / DSH 打开时接收 IM |
| 锁/attach | 先查 `manager.lock`：live 则 attach，否则 owned |
| 日志 | DSH 宿主日志（`im-manager/*` scope） |

### 10.2 插件配置（profile patch row）

```yaml
- insert:
    - id: im-manager
      name: dsh-im-manager
      config:
        mode: manager
        managerFile: ""
        host: 127.0.0.1
        port: 8788
        autoStart: true
        startAllWorkspaces: false
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `gateway` | `manager`（多工作区）或 `gateway`（旧的单工作区模式）；未知值回退 gateway 并 warn |
| `configFile` | `""` | 仅 `gateway` 模式：单工作区配置路径；空 = 走配置查找顺序 |
| `managerFile` | `""` | manager 模式：manager.json 路径；空 = `~/.dsh-im-manager/manager.json` |
| `host` | `"127.0.0.1"` | manager HTTP API 监听地址（建议只 loopback） |
| `port` | `8788` | manager HTTP 端口 |
| `autoStart` | `true` | 插件挂载时是否启动 manager（false 时首次调用工具/页面才惰性启动） |
| `startAllWorkspaces` | `false` | true 时 manager 启动后把所有已配置工作区都拉起（否则只起 `autoStart` 工作区） |

`install/activate.sh` 默认写上面这行（manager 模式）；`--gateway` 写旧的单工作区行；
`DSH_IM_MANAGER_PORT` / `DSH_IM_MANAGER_FILE` 可覆盖端口/manager 文件。
**不要装进 `sdk` profile。**

### 10.3 生命周期

```
DSH 加载 profile
  └─ plugin.apply()
       ├─ 注册工具（im_gateway_status/pair/allow/send）
       └─ autoStart: ensureManager()
            ├─ SDK runtime 守卫（--profile sdk → 拒绝）
            ├─ 读 manager.lock：live owner → attach（不再创建 manager）
            ├─ 抢锁失败但 PID 已死 → 清理 stale lock 后 owned
            ├─ owned：createManager → init → API.start(host,port)
            │         → 更新 lock 的实际端口 → manager.start()
            │         → startAllWorkspaces=true 时再启动其余工作区
            └─ 端口被健康 manager 占用 → attach（不抢锁）
DSH 卸载/退出
  └─ plugin.dispose()
       ├─ owned：API.stop → manager.stop → 释放 lock
       └─ attach：什么都不停（owner 是别的进程）
```

- **SDK runtime 守卫**：在 `--profile sdk`（或 `DSH_PROFILE=sdk`）里 manager 模式会直接报错，
  防止「gateway 再 spawn SDK runtime → 又加载插件」的递归；插件只在 `desktop`/`web` 等宿主 profile 用。
- **owned / attach**：attach 时工具通过 loopback HTTP 访问已有 manager，行为和 owned 一致。
- **dispose 幂等**：重复 dispose 安全；attach 模式不会误停别人的 manager。
- **端口忙**：若 8788 被一个**健康**的 manager（`/api/health` ok）占用，插件 attach；
  被其它进程占用则启动失败，插件日志 warn，工具会报连接错误。

### 10.4 单实例锁

- 位置：`manager.json` 同目录的 `manager.lock`，默认 `~/.dsh-im-manager/manager.lock`，`0600`；
- 内容：`{version, pid, token, host, port, managerFile, startedAt}`；`token` 保证只有当前 owner
  能更新/释放锁（旧 owner 不会误删新锁）；
- 获取：`O_EXCL` 创建；已存在且 PID 存活 → 返回 existing（CLI 打印提示、插件 attach）；
  PID 已死/文件损坏 → 视为 stale，删除后重试一次；
- 独立 CLI `manager` 与 host plugin 共用这把锁：
  - 第二个 CLI：输出 `manager 已在运行（pid …）：http://…/`，退出码 0，不启动第二个；
  - host plugin：attach 到锁里的 `host:port`，不创建 manager；
- 不同 `managerFile` 使用**不同的锁**（互相独立）；但多个 manager 同时抢同一端口仍会冲突，
  通常只应有一个 manager 占用 8788。

### 10.5 工具行为（manager 模式）

工具名与 gateway 模式一致，只是语义变成「多工作区」：

| 工具 | manager 模式行为 |
| --- | --- |
| `im_gateway_status` | 聚合所有工作区状态/渠道健康/待配对/manager HTTP 地址 |
| `im_gateway_pair` | 批准某个工作区的配对码；可选 `workspace` |
| `im_gateway_allow` | 直接把 sender 加进某工作区 allowlist；可选 `workspace` |
| `im_gateway_send` | 通过某工作区的运行中渠道主动发消息；可选 `workspace` |

`workspace` 解析规则：显式值按 id → name → `workspaceDir` 匹配；不传时：只有一个 running
工作区则自动选它；没有 running 但只有一个工作区也自动选；多个 running 时必须传，否则报错
（避免把消息发错工作区）。工具通过本地 HTTP 调用 manager，所以 attach/owned 行为一致。

### 10.7 排障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 插件日志 `manager mode is disabled inside a DSH SDK runtime` | 装到了 sdk profile / 在 SDK runtime 里加载 | 只装 desktop/web；`activate.sh --remove` 后改 profile 重装 |
| 插件启动但页面无数据/API 不可用 | manager 未启动（autoStart=false 且没调用工具）、端口冲突 | 看 DSH 宿主日志 `im-manager/manager`；`curl 127.0.0.1:8788/api/health` |
| 端口被非 manager 进程占用 | 8788 被其它服务占用 | 停掉占用进程，或 `DSH_IM_MANAGER_PORT` 换端口并重装 patch row |
| 锁 stale（上次宿主崩溃） | `manager.lock` 里 PID 已死 | 下次启动自动清理；确认没有 manager 在跑时可手动删除 lock |
| 两个宿主/CLI 同时启动 | 一个 owned，其余 attach | 正常；但只有 owner 负责停止，dispose owner 会让 attach 方断开 |
| 工具报 `multiple running workspaces; pass workspace` | 多个工作区在运行但没传 workspace | 传 `workspace: <id>`；id 可用 `im_gateway_status` 查看 |
| 热重载后 IM 短暂中断 | `activate.sh` 修改 patch 层触发热重载 | 预期行为；安装/升级尽量放在不使用时进行 |
| 升级后仍是旧代码 | patch 层未重载/包未复制 | 重新 `bash install/activate.sh`（会重新 rsync），必要时重启 DSH |

### 10.8 验证状态

- 隔离 profile：`bash install/verify-plugin.sh` 已验证 apply → `manager mode: owned` →
  dispose + lock 释放；
- attach：isolated profile 指向本机已运行的 manager 时打印
  `manager mode: attach at http://127.0.0.1:8788`，manager.lock token 不变，`/api/health` ok；
- **真实 desktop profile 已安装**（2026-10-18，`~/.dsh/profiles/desktop`）：DSH 宿主进程 owned 持锁，`dsh` 工作区 autoStart 拉起，`im_gateway_*` 工具在 DSH 会话内可调用；D-v2 原生页面（§10.5）已实现并在隔离 web profile 验证，真实 desktop 需重启 DSH 后在侧栏「消息」看到（设置里不再放入口）。

## 11. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `EADDRINUSE` / API 不可用 | 8788 被占用 | 改 `manager.json` 的 `listen.port` 后重启 DSH；`lsof -nP -iTCP:8788` 找占用进程 |
| 工作区 `state=error` | 配置无效、渠道鉴权失败、`dsh` 不可用、端口冲突 | 看详情里的 error + 日志；对该工作区执行 `dsh-im-manager doctor --config <configFile>`；修好后重启 |
| 工作区起不来但配置看起来没问题 | 固定端口被占（手工配置的 `http.port` 不是 0）、同一渠道账号已被另一个工作区占用 | 改端口 / 停掉另一个工作区 / 换账号 |
| 「配对请求」为空 | 工作区未运行、没有新用户触发配对、或已批准 | 先确认工作区 running；让用户再发一条消息；刷新 |
| 保存配置后对话中断 | 运行中保存会重启该工作区 | 正常行为；等重启完成后再发消息 |
| 点「启用」返回 409 | 渠道已经 `enabled:true` | 先停用/关闭该渠道，或直接使用已启用渠道；不要重复连接 |
| 二维码过期/一直 pending | 手机未在有效期内扫码确认 | 弹窗里点「重新生成二维码」；或关闭后重新点启用 |
| 关闭弹窗后渠道却启用了 | 不应发生（关闭未确认会 cancel 并保持 disabled） | 检查该渠道是否原本已启用；刷新页面/看配置 `GET .../config` |
| 飞书扫码成功但机器人不回 | 扫码创建的应用缺少机器人/消息权限 | 去飞书开放平台给应用开权限并发布版本 |
| 微信扫码成功但状态未登录 | 凭据文件未生成/无效 | 看 `GET logs`；必要时 CLI `dsh-im-manager weixin status` / 重新扫码 |
| 修改 `manager.json` 不生效 | 运行中不热加载 | 重启 manager |
| 删除工作区后文件还在 | 设计如此（不删配置/凭据/会话） | 确认不再需要后手动删除 `configFile` 与 `stateDir` |
| 两个工作区同一渠道频繁掉线 | 同一账号长连接互相抢占（飞书 ws / 钉钉 stream / 企微 ws / 微信个人） | 每个工作区用独立账号；或只在一个工作区启用该渠道 |
| API 404 | 方法/路径不匹配 | 对照 §7 表格；`GET /` 只返回服务信息 |

## 12. 限制（v1）

- 只监听 loopback，无鉴权/TLS/多用户/权限系统；
- 扫码连接只支持 `weixin` 和 `feishu`；钉钉/企业微信仍为「保存配置即启用」；
- 真实扫码确认需要用户手机操作，自动化只覆盖到 QR 生成/cancel/状态机；
- 飞书扫码创建出的应用权限/发布状态影响真实收发，manager 不做权限检查；
- 不做「渠道账号占用锁」：同一账号跨工作区并发绑定会抢长连接，需要人工避免；
- manager.json 不热加载；修改后需重启 manager；
- 关闭扫码弹窗会 cancel 当前 flow，但二维码在平台侧的实际失效时间由 provider 决定；
- 删除工作区不清理磁盘文件；
- 不做资源限额/调度（每个工作区一个 DSH runtime 子进程，注意内存/CPU）；
- 不做公网/多机部署、不做 manager 高可用。

## 13. 相关文档

- [manager-contract.md](manager-contract.md)：manager/API 的冻结契约（开发者）
- [configuration.md](configuration.md)：单工作区 gateway 配置字段（manager 不改格式）
- [operations.md](operations.md)：日志、升级、排障
- [security.md](security.md)：渠道/密钥/访问控制安全
- [verification.md](verification.md)：测试与验证记录

### 10.5 DSH 原生页面（D-v2）

包在 `package.json` 中声明 `dsh.client`，并导出预构建的 `lib/client.js`：

```json
"exports": { "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web", "inject": [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-api-session-controller"
] } }
```

client 半边只注册一个入口（id `im-manager`，标题「消息」）：

- `sidebar.panellist` + `main`：侧栏入口，位于「插件」和「自动化任务」之间；设置页不再放第二入口。

页面是原生 React 实现，视觉/交互对齐 DSH 内置「插件」页（同款 `page/pageHead/group/cards/rows`
布局、DSH `Button`/`Input` primitives、`--dsw-alias-*` 主题 token，浅色/深色自适应）；不嵌入
iframe，也不硬编码 8788：

- host 半边在 manager 模式下通过 `ctx.inject(['webServer','connection'])` 注册同源前缀路由
  `/im-manager`，handler 先走 `connection.admit(req)` 的 owner 门禁，再分发 JSON 端点；
- owned 模式直接调 manager 对象，attach 模式用 `manager-client` 的 HTTP adapter；
- 端点：`discover`、`state`、`workspace.{add,adopt,update,start,stop,restart,remove}`、`config.{get,save}`、
  `pairing.{list,approve,allow}`、`connect.{begin,get,cancel}`、`logs`、`message.send`；
- client 通过 `ctx.connection.rpc.call('/im-manager', endpoint, payload)` 访问，失败返回
  `{ok:false,error:{code,message,details}}`；
- 本机 HTTP API 8788 仅用于 attach/健康检查，不再提供浏览器页面。

### 10.7 DSH 工作区发现与按需 Gateway（D-v2.5）

- `discover` RPC：host 读取 `ctx.workspaceRegistry.list()` 并合并 manager state，返回
  `{ workspaces: [{ workspaceId, title, path, updatedAt, managerId|null, gateway|null }], unlinked }`；
- GUI 列表默认展示**当前 profile 的所有 DSH 工作区**；没有 manager 绑定的显示「未创建 Gateway」，
  详情里可通过 `workspace.adopt`（幂等，按 workspaceDir 匹配）创建配置并启动；
- 已在 manager 里但不在当前 profile 的条目放到「其他 Gateway 条目」，不会被隐藏；
- 每个工作区仍是独立 gateway + 独立 DSH runtime；`autoStart` 控制宿主启动时是否自动拉起；
- 配置弹窗补齐飞书（webhook/token/encryptKey/bot）、钉钉（signatureSecret/webhookPath/botUserId）、
  企微（webhookPath/wsUrl）字段；密钥继续脱敏，`***` 留空保留。

限制/后续：D-v2 原生页面覆盖工作区生命周期、飞书/微信扫码启用、飞书手动凭据、配对/allowlist、
日志，以及飞书/钉钉/企微的完整字段编辑。下一步是事件订阅引导与二维码登录的更多状态。

### 10.6 IM 会话同步到 DSH 侧栏（D-v2.2）

- manager 新增 `getSessionActivity()` 与 `GET /api/sessions/activity`、RPC `activity`：
  返回运行中 gateway 的会话绑定（`revision` + 每工作区 sessionId/lastUsedAt）。
- client 半边在插件 `apply` 时每 2s 轮询 `activity`；`revision` 变化（首条 IM 消息创建 session、
  `/new` 轮换、后续消息 touch）时调用 `ctx.sessions.refresh()`，并在 1.5s 后再刷一次，
  让 DSH 侧栏按 `session header.cwd` 归入对应 workspace。
- **工作区归组**：gateway runtime 是独立 SDK 进程，它写出的会话不会被 DSH workspace 注册表自动
  “记账”，因此只刷 session 列表会落到「未分组」。host 插件在每次 activity RPC 时调用
  `workspaceRegistry.resolveByPath(workspaceDir)` + `workspace.attachSession(sessionId)`（校验
  session header cwd），workspace 变更再经 workspace follow 推给 client，侧栏即归入对应工作区。
  未持久化/路径不匹配的会话是 best-effort，下次轮询重试。
- **历史回填**：workspace 注册表只在启动时 bootstrap 一次已存在会话；插件升级前/插件没运行时
  产生的旧会话仍会留在「未分组」。插件 apply 后 1.2s 用 `ctx.sessionQuery.listSessions()` 扫描
  全部持久会话，cwd 匹配的未记账会话逐个 `attachSession`（best-effort，失败跳过）。
- 会话语义：首次 IM 消息创建默认 session；后续消息沿用；`/new` 才轮换（gateway 原有行为，
  `test/core/gateway.test.js` 覆盖）。
