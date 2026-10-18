# 运维

本文覆盖常驻运行、日志、状态检查、升级与故障排查。命令默认写作 `dsh-im-manager`，
未 `npm link` 时等价于 `node bin/dsh-im-manager.js`。

## 1. 运行前置

- Node.js >= 22.19；`node --version` 可执行；
- `dsh --version` 可执行，且 `dsh --profile sdk --dump-config` 输出包含
  `dsh-sdk-jsonrpc-server`（`doctor` 会替你检查）；不在 PATH 时设
  `DSH_IM_MANAGER_DSH=/path/to/dsh`；
- 配置文件就绪（`dsh-im-manager init` 可从示例生成）；
- 微信（个人）渠道额外需要：手机微信（用于扫码确认登录），以及出站访问
  `ilinkai.weixin.qq.com` 的网络。

## 2. 前台运行

```bash
dsh-im-manager doctor --config ~/.dsh/im-manager/config.json
dsh-im-manager serve  --config ~/.dsh/im-manager/config.json
```

`serve` 会打印 pid、HTTP 地址与状态目录；Ctrl+C（SIGINT）或 SIGTERM 触发优雅退出：
停止接收新消息 → 关闭渠道连接 → 停止 DSH bridge（shutdown → SIGTERM → SIGKILL）。
进程退出码：正常停止为 0，启动失败为 1。

## 2.1 多工作区 manager 前台运行

```bash
dsh-im-manager manager [--config <manager.json>] [--host 127.0.0.1] [--port 8788]
```

- 默认监听 `127.0.0.1:8788`，启动后打印 Web UI 地址与 manager.json 路径；
- 首次运行会自动创建 `~/.dsh-im-manager/manager.json`（若当前目录有
  `.dsh-im-manager/config.json` 会把它加入为第一个工作区）；
- Ctrl+C / SIGTERM：停止所有工作区（每个 gateway 优雅关闭）→ 关闭 API → 退出；
- 单个工作区启动失败只标记该工作区 `state=error`，manager 继续服务其它工作区；
- 新建工作区的渠道默认都是关闭的：在 UI 渠道卡片里启用——飞书/微信点「启用」扫码（飞书可选手动
  填 App ID/Secret），钉钉/企微保存配置即启用；关闭未确认的扫码弹窗不会启用渠道；
- 详细用法见 [manager.md](manager.md)（扫码连接见 §6）。

## 2.5 以 DSH 宿主插件方式运行

如果不想单独守一个进程，可以把 manager 挂进 DSH 宿主（v1.1 默认就是 manager 模式）：

```bash
bash install/activate.sh          # 默认 desktop profile：复制包 + 追加 mode: manager 的 patch row
DSH_PROFILE=web bash install/activate.sh
bash install/activate.sh --gateway  # 旧行为：单工作区 gateway 模式
bash install/verify-plugin.sh     # 可选：隔离 DSH_HOME 验证加载/owned 启动/锁释放
```

- manager 模式启动后：DSH 加载 profile → 内嵌 manager（HTTP API/Web UI）→ 启动 `autoStart`
  工作区；Web UI 仍是 `http://127.0.0.1:8788/`，配置 `~/.dsh-im-manager/manager.json`；
- 单实例锁 `~/.dsh-im-manager/manager.lock`：已有 manager（CLI/另一个宿主）时插件 **attach**，
  不重复启动；插件 dispose 只停自己的 manager；
- 挂载后在 DSH 对话里可用 `im_gateway_status`（聚合所有工作区）、`im_gateway_pair`、
  `im_gateway_allow`、`im_gateway_send`（pair/allow/send 可传 `workspace`）；
- **不要装进 `sdk` profile**：manager 模式在 `--profile sdk` 内会拒绝启动（防递归）；
- 卸载：`bash install/activate.sh --remove`（重启/热重载 DSH 生效）。
- 部署形态取舍见 §4.2；插件字段与排障见 [manager.md](manager.md) §10。

### 2.6 在 DSH Desktop 里看不到 IM 会话？

IM 会话由 `serve` 的独立 SDK runtime 写入 `<DSH_HOME>/sessions`，而 Desktop 的左侧会话列表
由 Desktop 宿主进程维护：外部进程新建的会话通常要**刷新页面（Cmd+R）或重开窗口**后才会出现。

排查顺序：

```bash
dsh-im-manager sessions --config <path>   # 确认映射（key → sessionId）存在
# 确认 DSH_HOME 与 Desktop 用的是同一个（默认 ~/.dsh）
```

`/new` 现在会立即调用 `session/working-directory/get` 把新 session 落盘（不再只是本地轮换 id），
但空白会话在 Desktop 里可能仍被隐藏，发第一条消息后最稳妥。

> 根因：Desktop 与网关是两个进程，会话列表没有跨进程的实时失效通知。要做到“发消息即出现在
> Desktop 侧栏且可点开”，需要把渠道桥接进宿主进程（embedded bridge，后续里程碑）。

## 3. 常驻：macOS launchd

保存为 `~/Library/LaunchAgents/com.example.dsh-im-manager.plist`（替换路径与用户名）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.dsh-im-manager</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/code/dsh-im-manager/bin/dsh-im-manager.js</string>
    <string>serve</string>
    <string>--config</string>
    <string>/Users/you/.dsh/im-manager/config.json</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/you/code/dsh-im-manager</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>FEISHU_APP_ID</key>
    <string>cli_xxx</string>
    <key>FEISHU_APP_SECRET</key>
    <string>xxx</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/dsh-im-manager.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/dsh-im-manager.err.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.example.dsh-im-manager.plist
launchctl list | grep dsh-im-manager
launchctl unload -w ~/Library/LaunchAgents/com.example.dsh-im-manager.plist
```

> 密钥也可以放独立的 `.env`（`chmod 600`），在 `ProgramArguments` 里用
> `/bin/bash -lc 'source /path/.env && exec node ...'`；但 launchd 的 plist 本身也
> 应限制权限（`chmod 600`），它可能包含密钥。

## 4. 常驻：Linux systemd（用户级）

`~/.config/systemd/user/dsh-im-manager.service`：

```ini
[Unit]
Description=dsh-im-manager (IM gateway for DeepSeek Harness)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/you/code/dsh-im-manager
Environment=PATH=/home/you/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/home/you/.config/dsh-im-manager.env
ExecStart=/home/you/.nvm/versions/node/v24.20.0/bin/node /home/you/code/dsh-im-manager/bin/dsh-im-manager.js serve --config /home/you/.dsh/im-manager/config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-im-manager
systemctl --user status dsh-im-manager
loginctl enable-linger "$USER"     # 退出登录后仍运行
```

> `EnvironmentFile` 每行 `KEY=value`，`chmod 600`。**不要**把密钥直接写进 unit 文件
> （unit 通常 world-readable；systemd 的 `Environment=` 也会出现在 `systemctl show` 里）。
>
> 多用户/开机即启场景可改成 `/etc/systemd/system/` 系统级 unit，并加 `User=`/`Group=`；
> 注意此时 `HOME` 与 `DSH_HOME` 可能不是你以为的目录，建议显式设置。

## 4.1 多工作区 manager 常驻（launchd / systemd）

manager 常驻时用同一条命令替换单工作区的 `serve`；它自己会启动/停止各工作区，所以**不需要**
为每个工作区再写一个 launchd/systemd 服务。

macOS launchd（`~/Library/LaunchAgents/com.example.dsh-im-manager.plist`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.dsh-im-manager</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/code/dsh-im-manager/bin/dsh-im-manager.js</string>
    <string>manager</string>
    <string>--config</string>
    <string>/Users/you/.dsh-im-manager/manager.json</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/code/dsh-im-manager</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>FEISHU_APP_SECRET</key>
    <string>xxx</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/dsh-im-manager.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/dsh-im-manager.err.log</string>
</dict>
</plist>
```

Linux systemd（`~/.config/systemd/user/dsh-im-manager.service`）：

```ini
[Unit]
Description=dsh-im-manager manager (multi-workspace + Web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/you/code/dsh-im-manager
Environment=PATH=/home/you/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/home/you/.config/dsh-im-manager.env
ExecStart=/home/you/.nvm/versions/node/v24.20.0/bin/node /home/you/code/dsh-im-manager/bin/dsh-im-manager.js manager --config /home/you/.dsh-im-manager/manager.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-im-manager
journalctl --user -u dsh-im-manager -f
```

要点：

- **工作区配置里的 `env:NAME` 在 manager 进程环境里解析**：launchd `EnvironmentVariables` /
  systemd `EnvironmentFile` 要包含所有工作区用到的变量；
- manager 启动时只自动启动 `autoStart=true` 的工作区；其余需要在 UI/API 里手动开始；
- 升级或重启 manager 会停止所有工作区（进行中的对话中断），恢复后按 `autoStart` 重新启动；
- manager 的 Web UI/API 日志在 manager 的 stderr（systemd journal）；每个工作区的最近日志在
  UI「日志」面板或 `GET /api/workspaces/:id/logs` 里（环形 500 行）。

## 4.2 部署矩阵：DSH host plugin vs 独立 CLI manager

| 维度 | DSH host plugin（mode=manager） | 独立 CLI manager（launchd/systemd） |
| --- | --- | --- |
| 启动 | 随 DSH 宿主加载 profile | 开机/登录常驻（§3/§4/§4.1） |
| 停止 | DSH 退出/卸载插件/热重载 | 手动停服务或进程退出 |
| 适合 | 桌面、本机、希望「DSH 开着才接 IM」 | 服务器/无头、长期在线、无人值守 |
| 锁/幂等 | 读 `manager.lock`，已有 owner 则 attach | 写 `manager.lock`，第二个 CLI 提示已在运行 |
| 崩溃恢复 | DSH 宿主/插件重载决定 | `KeepAlive` / `Restart=` 决定 |
| 日志 | DSH 宿主日志（`im-manager/*` scope） | 自己的 stderr（launchd 文件 / journal） |
| 升级 | 重新 `activate.sh` 复制包；patch 层 watcher 热重载 | 停服务 → 更新代码/依赖 → 启动 |
| 中断风险 | **热重载会 dispose 正在运行的 manager/工作区** | 只在重启服务时中断 |
| 安装位置 | `$DSH_HOME/profiles/<profile>/node_modules/dsh-im-manager` | 任意 checkout + launchd/systemd unit |

选择建议：

- 只想在自己用 DSH 时接 IM、不想额外守进程 → **host plugin**；
- 希望服务器 7×24 在线、DSH 不常开 → **CLI manager + launchd/systemd**；
- 两者共用同一把锁，可以「CLI 常驻 + 桌面 DSH 插件 attach」，但同一时刻只有一个 owner；
  不要在两个 DSH 宿主里都期望自己 owned。

**热重载注意**：`activate.sh` 会修改 profile 的 patch 层，DSH 的 live patch watcher 会立即
dispose/重载插件树，可能打断当前对话与该插件已启动的工作区。安装/升级尽量放在不使用时进行，
并先 `bash install/verify-plugin.sh` 在隔离 profile 里验证。

## 5. 日志

- 日志是 **JSON lines 写到 stderr**，每行一个 JSON 对象，字段：
  `time`、`level`、`scope`、`msg`，排障时可能带 `error`、`channel`、`conversationId` 等。
- 级别由 `gateway.log.level` 控制（`debug`/`info`/`warn`/`error`/`silent`，默认 `info`）。
- 日志中密钥字段会脱敏为 `***`，但仍不建议把日志原样贴到公开 issue。
- 查看方式：
  - 前台：直接看终端；
  - launchd：`tail -f ~/Library/Logs/dsh-im-manager.err.log`；
  - systemd：`journalctl --user -u dsh-im-manager -f`；
  - 只看错误：`journalctl --user -u dsh-im-manager -p err`；
  - **manager 模式**：manager 自身日志在 manager 的 stderr（launchd 文件 / systemd journal）；
    各工作区的最近日志在 Web UI「日志」面板或 `GET /api/workspaces/:id/logs?lines=200`
    （每工作区环形缓冲 500 行，已脱敏）；
  - **host plugin 模式**：manager 日志进入 DSH 宿主日志（scope `im-manager/*`）；装/卸或排障时可用
    `DSH_IM_MANAGER_PLUGIN_TRACE=1` 启动 DSH，plugin 会把 `plugin apply` / `manager mode: owned|attach` /
    `plugin dispose` 打到 stderr。`activate.sh` 的 `--remove` 不会删包，只移除 patch row。

## 6. 状态与体检

```bash
dsh-im-manager status [--json] --config PATH   # 0=运行中，1=未运行/无状态文件
dsh-im-manager doctor --config PATH            # 0=无 error，1=有 error
dsh-im-manager channels --config PATH          # 启用的渠道与模式
dsh-im-manager list --config PATH              # 允许列表 / 待配对（含过期时间）
```

- `status` 读取 `$stateDir/gateway.json`（运行时每 10 秒刷新）并 `kill(pid, 0)` 判断存活；
  进程被杀后状态文件可能仍存在，`status` 会显示“已停止”并返回 1。
- `doctor` 检查：配置文件、env 插值警告、`dsh --version`、SDK profile、HTTP 端口占用、
  各渠道字段校验、敏感策略提醒。渠道未启用时不校验其字段。
- 需要在聊天里看运行状态时用 `/status`。
- **manager 模式**没有单一的 `gateway.json`：用 `GET http://127.0.0.1:8788/api/health`
  探活，`GET /api/state` 看所有工作区；单个工作区仍可用
  `dsh-im-manager status --config <该工作区的 configFile>` 检查（读它自己的 `stateDir/gateway.json`）。

## 6.1 微信（个人）登录与凭据

`weixin` 不依赖 appId/secret，而是用手机微信扫码换取 iLink 登录态：

```bash
# 1) 终端渲染二维码，用微信扫码并在手机端确认
dsh-im-manager weixin login

# 2) 查看登录态（只显示 bot id / 用户 / base / 保存时间，不打印 token）
dsh-im-manager weixin status      # 0=已登录，1=未登录

# 3) 退出登录（删除凭据文件）
dsh-im-manager weixin logout
```

- 凭据写到 `channels.weixin.credentialsFile`；留空时为
  `<gateway.stateDir>/channels/weixin/credentials.json`，权限 `0600`。
- 登录与 `serve` 解耦：可以先 login 再 serve；网关常驻时扫码成功后**数秒内自动开始收发**
（adapter 监听凭据文件变化并启动长轮询）。未登录时启用渠道也不会阻止 `serve` 启动，
此时该渠道 health 为 `disconnected`。
- 凭据等价于微信登录态：**不要提交到仓库、不要贴到聊天/issue**。
- 二维码有有效期，超时/手机未确认时重新执行 `weixin login` 即可。
- `weixin` 只作出站连接（长轮询），不监听 HTTP 端口；防火墙不需要为它开放入站。
- 同一微信号同时只应有一个网关实例使用；多个实例共用同一份凭据可能互相踢下线。

## 7. 升级

```bash
# 1) 停止
launchctl unload -w ~/Library/LaunchAgents/com.example.dsh-im-manager.plist
# 或 systemctl --user stop dsh-im-manager

# 2) 更新代码与依赖（不要跳过 install：adapter 依赖平台 SDK）
git -C /path/to/dsh-im-manager pull
cd /path/to/dsh-im-manager && npm install

# 3) 体检（重点看 dsh / profile / 新增配置字段）
dsh-im-manager doctor --config ~/.dsh/im-manager/config.json

# 4) 启动
launchctl load -w ...   # 或 systemctl --user start dsh-im-manager
```

- `stateDir` 默认 `~/.dsh-im-manager`，升级不需要清空；`sessions.json` 保持会话连续，
  微信（个人）的 `channels/weixin/credentials.json` 也会保留（除非登录态已被平台作废）。
- 跨大版本先备份 `stateDir` 与配置文件：
  `tar -czf dsh-im-manager-backup.tgz ~/.dsh-im-manager ~/.dsh/im-manager/config.json`。
- 升级后新增的配置字段有默认值；删掉的字段会被忽略（未知字段不报错）。
- 与 DSH 版本升级配套：若 `doctor` 报 profile 没有 `dsh-sdk-jsonrpc-server`，先升级 DSH。
- **manager 模式升级**：停止/重启 manager 会先停止所有工作区（对话会中断）→ 更新代码与依赖 →
  重新启动 manager；`manager.json`（`version: 1`）与各工作区配置保持兼容，新增字段走默认值。
  升级后建议在 UI 里逐个工作区「重启」并看日志确认渠道已连接；`PUT config` 保存也会自动重启
  对应工作区。
- **host plugin 升级**：重新执行 `bash install/activate.sh`（会 rsync 覆盖 profile 里的包；patch row
  有重复保护），DSH 的 patch watcher 会热重载插件；升级前先 `install/verify-plugin.sh` 在隔离
  profile 验证。热重载会 dispose 正在运行的 manager/工作区，选空闲时间操作；升级后确认
  `manager.lock` 正常、UI 可访问、各工作区渠道 connected。

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `no config file found` | 没有配置文件 | `dsh-im-manager init` 或 `--config` / `DSH_IM_MANAGER_CONFIG` |
| `config file ... is not valid JSON` | JSON 语法错误/带了注释 | 纯 JSON；`doctor` 会指出解析错误 |
| `config.env: environment variable X is required` | `env:X` 未设置 | 在启动环境/launchd/systemd 中导出 `X` |
| `dsh` 检查失败 | `dsh` 不在 PATH 或无执行权限 | 设 `DSH_IM_MANAGER_DSH`，或 `dsh.command` 写绝对路径 |
| `profile sdk does not mount dsh-sdk-jsonrpc-server` | DSH 版本不支持 SDK profile | 升级 DSH；`dsh --profile sdk --dump-config` 自查 |
| `port 8787 is in use` | HTTP 端口冲突 | 改 `gateway.http.port`，或停掉占用进程 |
| `channel "x" adapter failed to load` | 依赖未安装 | 在项目目录 `npm install` |
| 渠道启动失败（日志有 `channel failed to start`） | 密钥/字段缺失或网络不通 | 看该渠道日志与 [channels/](channels/index.md) 文档；`doctor` 会做字段校验 |
| 飞书连不上 | appId/appSecret 错误、未开机器人/长连接、应用未发布 | 平台后台检查权限与版本；webhook 模式再查 `verificationToken`/`encryptKey` |
| 钉钉连不上 | clientId/Secret 错误、机器人未发布、Stream 未开启 | 检查应用与机器人配置；webhook 模式检查签名配置 |
| 企业微信连不上 | botId/secret 错误；webhook 模式 token/AESKey/corpId/agentId 不匹配 | 对照 [wecom.md](channels/wecom.md)；检查可信 IP |
| 企业微信 40001/40014/42001 | secret/token 无效或过期 | 重新核对 secret、token、AESKey |
| 发消息 45009 / 频率限制 | 平台限流 | 降低发送频率；等配额窗口恢复 |
| 收到消息无回复 | 访问控制拦截 / 群未启用 / 未 @ / 重复消息 / Agent 报错 | 看日志 `inbound denied`、`duplicate inbound dropped`；用 `/id` 加白；群开 `groups.enabled` |
| 微信（个人）收不到消息 | 未登录 / 登录态过期 / 渠道未启用 / `allowFrom` 拦截 | `dsh-im-manager weixin status`；未登录就重新 `weixin login`；检查 `channels.weixin.enabled` 与日志 `inbound denied` |
| 微信（个人）日志报 `-14` / `token invalid` | 登录态失效（过期、被踢、换设备） | 重新执行 `dsh-im-manager weixin login` 扫码；不要手动编辑 `credentials.json` |
| `weixin login` 不显示二维码 | 终端不支持、非交互式 / SSH 环境 | 在本地终端运行；或按输出的链接在微信内打开 |
| 扫码后仍显示未登录 | 手机端未确认、二维码过期、依赖缺失 | 重新 login；确认 `npm install` 安装了 `qrcode-terminal` |
| weixin 反复重连 | 出站网络/代理问题；或 token 失效 | 检查到 `ilinkai.weixin.qq.com` 的出站连通；`-14` 时重新扫码；可调 `reconnect.baseDelayMs` / `maxDelayMs` |
| 回复发送失败后只发纯文本 | adapter 不支持 markdown，core 自动降级一次 | 正常行为；持续失败看渠道日志 |
| bridge 反复重启 | DSH 认证/模型配置错误或崩溃 | 看 bridge stderr 日志；先手动跑 `dsh --profile sdk` 验证 |
| `/status` 一直显示未就绪 | bridge 未 ready | `dsh` 检查、profile 检查；稍后重试 |
| manager `EADDRINUSE` / UI 打不开 | 8788 被占用 / manager 未运行 / 非 loopback | `curl http://127.0.0.1:8788/api/health`；`lsof -nP -iTCP:8788`；改 `--port` 或 manager.json `listen.port` |
| manager 里工作区 `state=error` | 配置无效 / 渠道鉴权 / `dsh` 不可用 / 端口冲突 | UI 的 error + 日志；`dsh-im-manager doctor --config <configFile>`；修好后重启 |
| 两个工作区同一渠道互踢 | 同一账号长连接被两个 gateway 抢占 | 每个工作区用独立账号，或只在一个工作区启用该渠道 |
| 保存配置后对话中断 | 运行中保存会重启该工作区 | 正常行为；等重启完成再发消息 |
| 改了 manager.json 不生效 | manager 不热加载 manager.json | 重启 manager |
| host plugin 不启动 manager | 装进了 sdk profile（被守卫拒绝）/ autoStart=false / 端口不健康 | 只装 desktop/web；看 DSH 日志 `im-manager/*`；`curl 127.0.0.1:8788/api/health` |
| 两个 manager 抢 8788 / 渠道互踢 | 多个 owner 同时启动 | 只保留一个；锁机制会让后来者 attach/提示已在运行，确认没有手动绕过锁的旧进程 |
| plugin 卸载后仍在运行 | patch row 还在 / 未重载 | `bash install/activate.sh --remove` 后重启/等 DSH 热重载 |
| 想重置某个会话 | 上下文异常 | 聊天里发 `/new`；不要删 `sessions.json`（运行中会被写回） |

## 9. 多实例与隔离

- 一个进程内每个渠道一个账号；要多账号就起多个进程，并给每个实例不同的
  `gateway.stateDir` 和 `gateway.http.port`（webhook 模式还要不同的公网路径/域名）。
- 不要让两个进程共用同一个 `stateDir`：`gateway.json`、`sessions.json`、`pairing.json`
  会互相覆盖。
- 测试环境可用单独的 `DSH_HOME` 与 `stateDir`，避免污染生产会话。
- **不要**对同一个工作区配置同时跑 `serve` 和 `manager`（同一 `stateDir`/端口/渠道账号会冲突）；
  多工作区统一交给 manager 管理即可。
- **host plugin 与 CLI manager** 共用 `~/.dsh-im-manager/manager.lock`：可以共存（后启动者 attach），
  但只有一个 owner；owner 退出会停止 manager，attach 方会断开。不要同时装两个 host plugin 实例。

## 10. 安全运维清单

- [ ] 配置文件与 env 文件 `chmod 600`，密钥用 `env:`；
- [ ] `dmPolicy` 不是 `open`（除非在封闭测试环境）；
- [ ] 群聊按需开启，`groups.allowFrom` 精确到群；
- [ ] `http.host` 保持 `127.0.0.1`，公网只暴露反向代理的 443；
- [ ] 反向代理配置 HTTPS 与来源限制；
- [ ] 定期 `dsh-im-manager list` 清理不再使用的 allowlist 条目；
- [ ] 微信（个人）凭据文件 `chmod 600`，不提交、不备份到公开位置；
- [ ] manager 的 Web UI/API 只监听 loopback，不暴露公网（无鉴权/TLS）；`manager.json` 与工作区配置 `0600`；
- [ ] 不给多个工作区绑定同一个渠道账号（尤其长连接/扫码类）；
- [ ] host plugin 只装 desktop/web profile，**不装 sdk profile**；安装/升级前先跑 `install/verify-plugin.sh`；
- [ ] 清楚当前 manager 的 owner（CLI 或某个 DSH 宿主），避免多个 owner 抢 8788/渠道；
- [ ] 热重载前确认没有正在进行的重要对话（插件重载会停止内嵌 manager）。
