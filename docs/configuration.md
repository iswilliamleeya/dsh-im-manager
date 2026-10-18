# 配置

配置文件是 JSON（**不支持注释**），完整示例见
[config.example.json](../config/config.example.json)。

## 1. 配置文件查找顺序

按优先级从高到低：

1. 命令行 `--config <path>`；
2. 环境变量 `DSH_IM_MANAGER_CONFIG`；
3. **工作区本地配置**：当前目录下的 `.dsh-im-manager/config.json`（由 DSH「消息」创建 Gateway 时生成）；
4. `$DSH_HOME/im-manager/config.json`（`DSH_HOME` 未设置时为 `~/.dsh`）；
5. 当前工作目录下的 `config/config.json`（仓库内旧约定）。

工作区本地配置优先级高于机器级配置：`cd <workspace>` 后执行 `serve` / `doctor` / `pair` /
`weixin login` 都会自动找到这个工作区的配置与 `stateDir`，不需要 `--config`。

都找不到时，`serve` / `doctor` 会报错退出；`doctor` 可显式给 `--config` 检查任意路径。
路径支持 `~` 展开，相对路径按当前工作目录解析。

`config.example.json` 只是示例。推荐工作区级安装：

```bash
cd <workspace>
# 在 DSH 侧栏「消息」里创建 Gateway 会写入 <workspace>/.dsh-im-manager/config.json
```

机器级安装可以复制成 `~/.dsh/im-manager/config.json`：

```bash
mkdir -p ~/.dsh/im-manager
cp config/config.example.json ~/.dsh/im-manager/config.json
```

## 2. 环境变量插值

所有字符串值（含数组元素、嵌套对象）都支持两种写法：

| 写法 | 行为 |
| --- | --- |
| `"env:NAME"`（**整个值**恰好是它） | 从环境变量 `NAME` 取完整值；缺失或为空时产生一条警告，值按空字符串处理 |
| `"${NAME}"`（可嵌在任意字符串中） | 把 `${NAME}` 替换为环境变量值；缺失时警告并按空字符串替换 |

- `NAME` 必须匹配 `[A-Za-z_][A-Za-z0-9_]*`。
- 插值发生在默认值填充与校验之前；插值后的值参与校验。
- `env:` 必须**整值匹配**，`"env:FOO bar"` 不会被解析。
- 推荐敏感字段一律用 `env:`（例如 `"appSecret": "env:FEISHU_APP_SECRET"`），
  配置文件里不要出现明文密钥。

```jsonc
{
  "channels": {
    "feishu": {
      "appId": "env:FEISHU_APP_ID",
      "appSecret": "env:FEISHU_APP_SECRET",
      "allowFrom": ["${ADMIN_FEISHU_OPEN_ID}"]
    }
  }
}
```

> 上例用了 `jsonc` 只为展示；真实配置必须是纯 JSON，不能带注释。

## 3. 合并规则与默认值

用户配置与内置默认值**深合并**：对象递归合并；数组和标量整体覆盖。
因此只写想改的字段即可。`~` 只会在 `dsh.cwd`、`dsh.home`、`gateway.stateDir`
等路径字段上展开。

## 4. `dsh`：DSH runtime 子进程

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `command` | string | `"dsh"` | DSH 可执行文件；测试时可指向假 runtime |
| `args` | string[] | `["--profile","sdk"]` | 传给 `command` 的参数 |
| `cwd` | string（绝对路径） | 进程当前目录 | Agent 的工作目录（决定它看到的仓库） |
| `home` | string | `""` | 子进程的 `DSH_HOME`；留空则继承当前环境 |
| `env` | object | `{}` | 额外注入子进程的环境变量（字符串键值） |
| `provider` | string | `"deepseek-official"` | `initialize` 的 provider |
| `model` | string | `"deepseek-chat"` | `initialize` 的 model |
| `reasoningEffort` | string | `""` | 留空不传；否则传给 `initialize` |
| `maxTokens` | number \| null | `null` | 留空不传；正整数时传给 `initialize` |
| `initTimeoutMs` | number | `60000` | `initialize` 超时 |
| `turnTimeoutMs` | number | `600000` | 单轮 Agent 回复超时 |
| `requestTimeoutMs` | number | `60000` | 普通 JSON-RPC 请求超时 |
| `restart.minDelayMs` | number | `1000` | 崩溃重启退避下限 |
| `restart.maxDelayMs` | number | `30000` | 崩溃重启退避上限 |

## 5. `gateway`：网关行为

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `stateDir` | string | `"~/.dsh-im-manager"` | 状态目录（会话映射、去重、配对、媒体、日志状态） |
| `concurrency` | integer ≥1 | `4` | 同时进行的 Agent turn 上限（不同会话之间） |
| `log.level` | `debug`\|`info`\|`warn`\|`error`\|`silent` | `"info"` | 日志级别，JSON lines 写 stderr |
| `http.enabled` | boolean | `true` | 是否启动 webhook HTTP 宿主 |
| `http.host` | string | `"127.0.0.1"` | 监听地址；公网部署需改为 `0.0.0.0`（并加反代） |
| `http.port` | integer 0-65535 | `8787` | 监听端口；`0` 表示随机端口 |
| `http.publicBaseUrl` | string | `""` | 平台回调的对外基址；留空按 `http://host:port` 推导 |
| `access.dmPolicy` | `pairing`\|`allowlist`\|`open` | `"pairing"` | 私聊访问策略，见 [security.md](security.md) |
| `access.allowFrom` | string[] | `[]` | 全局允许的发送者 id；`"*"` 全放行 |
| `access.pairingTtlSec` | number | `600` | 配对码有效期（秒） |
| `access.groups.enabled` | boolean | `false` | 是否处理群消息 |
| `access.groups.requireMention` | boolean | `true` | 群内是否必须 @ 机器人 |
| `access.groups.allowFrom` | string[] | `[]` | 允许的群 `conversationId`；空数组表示所有群 |
| `reply.chunkChars` | number ≥100 | `1800` | 单条回复最大字符数，超出分片 |
| `reply.maxChunks` | integer ≥0 | `6` | 单条回复最多分片数；`0` 表示不限制 |
| `reply.typing` | boolean | `true` | 是否使用平台的「正在输入」 |
| `reply.format` | `auto`\|`plain`\|`markdown` | `"auto"` | 出站格式；adapter 不支持 markdown 时自动降级 |
| `reply.showErrorDetail` | boolean | `false` | 失败提示是否带具体原因 |
| `reply.emptyText` | string | `"（本轮没有文本输出）"` | 正常完成但 Agent 没有文本输出时发送的占位文本 |
| `gateway.media.maxInlineImageBytes` | number | `8388608` | 入站图片内联为 image block 的上限；超过则只给 Agent 路径/URL 提示 |
| `gateway.media.dir` | string | `".dsh-im-manager/media"` | 入站文件复制到工作区内的相对目录（Agent 文件工具可读） |

## 6. `channels`：渠道

公共字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用该渠道 |
| `accountId` | string | 渠道 id | 账号标识，参与会话键 |
| `mode` | string | 见各渠道 | 平台运行模式 |
| `allowFrom` | string[] | `[]` | 该渠道的发送者/群白名单（与全局取并集） |
| `groups` | object | `{}` | 覆盖全局 `gateway.access.groups` 的对应字段 |
| `dmPolicy` | `pairing`\|`allowlist`\|`open` | 继承全局 | 该渠道私聊策略覆盖（可选） |
| `webhookPath` | string | 见各渠道 | webhook 模式路径（`weixin` 无 webhook，不使用） |

平台特有字段：

| 渠道 | 模式 | 字段 |
| --- | --- | --- |
| `feishu` | `ws`（默认）/ `webhook` | `appId`, `appSecret`, `domain`(`feishu`\|`lark`), `encryptKey`, `verificationToken` |
| `dingtalk` | `stream`（默认）/ `webhook` | `clientId`, `clientSecret`, `robotCode` |
| `wecom` | `ws`（默认）/ `webhook` | ws：`botId`, `secret`；webhook：`token`, `encodingAESKey`, `corpId`, `agentId` |
| `weixin` | `ilink` | `baseUrl`, `cdnBaseUrl`, `credentialsFile`, `requestTimeoutMs`, `longPollTimeoutMs`, `reconnect`, `typing`, `botAgent`, `media{download,maxBytes,timeoutMs,maxItemsPerMessage}`（**扫码登录后免密钥**） |

默认 webhook 路径：`/webhook/feishu`、`/webhook/dingtalk`、`/webhook/wecom`
（`weixin` 走长轮询，**不需要也不注册** webhook）。
各渠道的权限申请与平台侧配置见 [channels/index.md](channels/index.md)。

除上表外，每个渠道还有若干可选调优字段，**只在对应渠道文档中说明**，例如：

| 渠道 | 可选字段（示例） | 文档 |
| --- | --- | --- |
| 飞书 | `botOpenId`, `botName`, `markdownAsCard`, `replyInThread` | [feishu.md](channels/feishu.md) |
| 钉钉 | `botUserId`, `verifySignature`, `signatureSecret`, `markdownTitle`, `quoteReply` | [dingtalk.md](channels/dingtalk.md) |
| 企业微信 | `botName`, `wsUrl`, `heartbeatIntervalMs`, `apiBaseUrl`, `requestTimeoutMs` | [wecom.md](channels/wecom.md) |
| 微信（个人） | 见下方 §6.1 | [weixin.md](channels/weixin.md) |

### 6.1 微信（个人）`channels.weixin`

个人微信走腾讯官方 openclaw-weixin（iLink HTTP 协议），**扫码登录**，不需要 appId/secret，
也不需要公网入口。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用；示例配置里默认关闭，登录成功后按需打开 |
| `accountId` | string | `"weixin"` | 账号标识，参与会话键 |
| `mode` | `"ilink"` | `"ilink"` | v1 唯一模式 |
| `baseUrl` | string | `"https://ilinkai.weixin.qq.com"` | iLink API 根地址 |
| `cdnBaseUrl` | string | `"https://novac2c.cdn.weixin.qq.com/c2c"` | 媒体 CDN 根地址 |
| `credentialsFile` | string | `""` | 凭据文件路径；留空为 `<gateway.stateDir>/channels/weixin/credentials.json`；相对路径按该渠道目录解析 |
| `requestTimeoutMs` | number | `15000` | 普通 HTTP 请求超时 |
| `longPollTimeoutMs` | number | `35000` | 长轮询超时（服务端约 30s 返回） |
| `reconnect.enabled` | boolean | `true` | 断线是否自动重连 |
| `reconnect.baseDelayMs` | number | `2000` | 重连初始退避 |
| `reconnect.maxDelayMs` | number | `30000` | 重连退避上限 |
| `typing` | boolean | `true` | 是否尝试发送「正在输入」 |
| `botAgent` | string | `"dsh-im-manager"` | 请求 UA / 机器人标识 |
| `allowFrom` | string[] | `[]` | 发送者白名单（与全局并集） |
| `groups` | object | `{}` | 结构保留；个人微信 v1 仅单聊，`groups` 对本渠道无效 |
| `botType` | string | `"3"` | iLink bot 类型；一般不用改 |
| `credentialsCheckIntervalMs` | number | `3000` | 未登录时检查凭据文件变化（出现后自动启动）的间隔 |
| `loginTimeoutMs` | number | `300000` | 扫码登录整体超时 |
| `routeTag` | string | 无 | 可选的路由标记（高级/测试用） |
| `media.download` | boolean | `true` | 入站图片/文件/视频/语音是否下载并 AES 解密到本地；`false` 时只给 URL |
| `media.maxBytes` | number | `26214400` | 单个媒体下载上限（25 MiB），超限回退为 URL |
| `media.timeoutMs` | number | `30000` | 单个媒体下载超时 |
| `media.maxItemsPerMessage` | number | `8` | 单条消息最多下载的媒体数量 |

**登录行为**：启用但未登录时，`serve` 仍可正常启动，该渠道状态为 `disconnected`；
`dsh-im-manager weixin login` 扫码确认后，运行中的网关会在数秒内自动开始收发消息。
`weixin` 不需要 `gateway.http.enabled=true`，也不注册任何 HTTP 路由。

**凭据**：

- `dsh-im-manager weixin login` 在终端渲染二维码，微信扫码确认后凭据写入
  `credentialsFile`（默认 `<gateway.stateDir>/channels/weixin/credentials.json`，权限 `0600`）；
- `dsh-im-manager weixin status` 查看是否已登录（不打印 token，只显示 bot id/用户/base）；
- `dsh-im-manager weixin logout` 删除凭据文件；
- 凭据由 iLink 返回、腾讯可能随时失效；收到 `-14`（token invalid）时重新扫码登录。

> 不要把 `credentials.json` 提交到仓库或贴到群里；它等价于微信登录态。

## 7. 校验

- **加载时**（`loadConfig`）校验：必填字段类型、`dmPolicy` 枚举、`log.level` 枚举、
  `chunkChars ≥ 100`、端口范围、未知渠道名（只允许 `feishu`、`dingtalk`、`wecom`、`weixin` 四个）、路径为绝对路径等。
- **渠道字段完整性**由各 adapter 在 `start` 阶段校验，`doctor` 会逐渠道报告，
  不影响其他渠道启动。
- 配置错误信息会指出字段名；`doctor` 还会列出缺失/未设置的环境变量名。

## 8. 多工作区：`manager.json`（与 gateway 配置分开）

manager 使用一个**独立的** `manager.json`（默认 `~/.dsh-im-manager/manager.json`），
只记录工作区列表与 HTTP API 监听地址：

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

- **它不改变 gateway 配置格式**：`workspaces[].configFile` 指向的仍是本文 §2–§7 描述的普通配置，
  每个工作区一份、互不影响；
- manager/UI 新建工作区时生成：`dsh.cwd=workspaceDir`、`gateway.stateDir=<managerDataDir>/workspaces/<id>/state`、
  `gateway.http.port=0`；**v1.1 起所有渠道都写成 `enabled:false`**，创建时的渠道勾选只决定 UI 展示，
  启用走渠道卡片的扫码连接（飞书/微信）或保存配置（钉钉/企业微信），见 [manager.md](manager.md) §6；
  已有工作区配置原样使用；
- 配置中的 `env:NAME` / `${NAME}` 在 **DSH 宿主进程的环境变量**里解析（
  EnvironmentVariables/EnvironmentFile 要包含这些变量）；
- manager API 返回的配置会把密钥脱敏成 `***`；`PUT /api/workspaces/:id/config` 里含 `***` 的字段
  保留原值，校验通过后原子写回，运行中的工作区会自动重启；
- 工作区状态目录（`gateway.stateDir`）默认不在工作区内，而在 `~/.dsh-im-manager/workspaces/<id>/state`，
  这样多个工作区不会互相覆盖 `sessions.json`/`gateway.json`；
- 删除工作区只会从 manager.json 移除条目，不删除配置文件与状态目录。

完整说明见 [manager.md](manager.md)。
