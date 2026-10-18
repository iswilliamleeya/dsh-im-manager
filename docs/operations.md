# 运维、日志与排障

> 运行入口只有一个：**DSH profile bundle / 宿主插件**。独立 `serve`、独立 CLI `manager`、
> launchd/systemd 模板和浏览器 Web UI 均已移除；本机 HTTP API 只用于 attach/健康检查。

## 1. 前置

- Node.js >= 22.19（推荐 24）；
- 可用的 DSH Desktop / Web（`dsh --version`）；
- 各渠道应用凭据；个人微信另有扫码登录态；
- 不要装进 `sdk` profile（manager 会在 SDK runtime 里拒绝启动，防递归）。

## 2. 安装与运行

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile desktop add github:iswilliamleeya/dsh-im-manager

# 本地开发/离线：直接写 profile
bash install/activate.sh
bash install/activate.sh --remove

# 隔离 DSH_HOME 验证加载/释放，不动线上 profile
bash install/verify-plugin.sh
```

运行方式：

- DSH 启动时加载 profile → host 插件 `apply` → 内嵌 manager（owned）→ 启动 `autoStart` 工作区；
- 已有 live manager（另一个宿主）时 attach 到它的 HTTP API，不重复启动；
- DSH 退出/卸载插件时停止 manager 与全部工作区；
- 页面入口：DSH 左侧栏「消息」。

数据位置：

| 内容 | 路径 |
| --- | --- |
| manager 列表 | `~/.dsh-im-manager/manager.json`（0600） |
| manager 锁 | `~/.dsh-im-manager/manager.lock` |
| 工作区配置 | `<workspace>/.dsh-im-manager/config.json` |
| 工作区状态/凭据 | `<managerDataDir>/workspaces/<id>/state` |
| 微信个人凭据 | `<stateDir>/channels/weixin/credentials.json`（0600） |

## 3. 日志

- 工作区最近日志：DSH「消息」→ 工作区详情 →「最近日志」（manager 环形缓冲，已脱敏）；
- 宿主/manager 日志：DSH 宿主日志里 `im-manager/*` scope；
- 需要在终端深挖时：

```bash
curl -s http://127.0.0.1:8788/api/health
curl -s http://127.0.0.1:8788/api/state
curl -s 'http://127.0.0.1:8788/api/workspaces/<id>/logs?lines=200'
```

## 4. 状态与体检

```bash
dsh-im-manager doctor  [--config PATH]   # 配置 / dsh / SDK profile / 端口 / 渠道字段
dsh-im-manager status  [--config PATH]   # 读 stateDir/gateway.json 并检查 pid
dsh-im-manager channels [--config PATH]  # 已启用渠道
dsh-im-manager sessions [--config PATH]  # IM 会话 → DSH sessionId 映射
dsh-im-manager list    [--config PATH]   # allowlist / 待配对
dsh-im-manager pair <code>               # 批准配对码
dsh-im-manager allow <channel>:<senderId>
dsh-im-manager revoke <channel>:<senderId>
```

工作区 `state=error` 时，用 `doctor --config <workspace>/.dsh-im-manager/config.json` 查原因；
修好后在页面里重启该工作区。

## 5. 微信（个人）登录

```bash
dsh-im-manager weixin login    # 终端渲染二维码
dsh-im-manager weixin status   # 0=已登录，1=未登录
dsh-im-manager weixin logout   # 删除凭据
```

DSH「消息」页面的微信渠道也支持扫码启用；两条路径共用同一份凭据文件。登录态失效（`-14`）
后重新扫码即可，不要手动编辑 `credentials.json`。

## 6. 升级

```bash
# bundle 安装
dsh plugin --profile desktop add github:iswilliamleeya/dsh-im-manager

# 本地开发
bash install/activate.sh
```

- 客户端半边（`lib/client.js`）更新后需要**重启 DSH**；
- host 插件/patch 层变更可能触发热重载，进行中的 IM 对话会短暂中断；
- 升级前建议确认没有进行中的长任务。

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 侧栏没有「消息」 | 插件未加载/客户端 bundle 未更新 | 重启 DSH；看插件页是否已安装；确认 profile 不是 sdk |
| manager API 不健康 | 端口被占 / manager 未启动 | `curl 127.0.0.1:8788/api/health`；`lsof -nP -iTCP:8788`；改 `manager.json` 的 `listen.port` 后重启 |
| 工作区 `state=error` | 配置无效、渠道鉴权失败、`dsh` 不可用、端口冲突 | 看 error + 日志；`doctor --config <config>`；修好后重启 |
| 工作区起不来但配置看起来没问题 | 固定端口被占、同一渠道账号被其它工作区占用 | 改 `gateway.http.port=0` / 停掉另一个工作区 / 换账号 |
| 渠道起不来 | 凭据缺失/错误、机器人未发布、未登录 | 检查渠道配置；飞书发布版本；微信重新扫码 |
| 收到消息不回 | 访问控制拦截 / DSH runtime 失败 | 看日志 `inbound denied` / bridge 错误；`/id` 获取 senderId 加白 |
| 配对请求为空 | 工作区未运行 / 没有新用户触发 / 已批准 | 先确认 running；让用户再发一条；刷新 |
| 保存配置后对话中断 | 运行中保存会重启该工作区 | 正常行为；等重启完成 |
| 点启用返回 409 | 渠道已经 `enabled:true` | 先停用再连接，或直接使用 |
| 二维码过期 | 手机未在有效期内确认 | 点「重新生成二维码」；或关闭重开 |
| 关闭弹窗后渠道却启用 | 不应发生；可能原本已启用 | 看配置 `GET /api/workspaces/:id/config` |
| 飞书扫码成功但机器人不回 | 应用缺少机器人/消息权限 | 开放平台补权限并发布版本 |
| 微信扫码成功但状态未登录 | 凭据文件未生成/无效 | `weixin status`；重新扫码 |
| 修改 `manager.json` 不生效 | 运行中不热加载 | 重启 DSH |
| 两个工作区同一渠道频繁掉线 | 同一账号长连接互相抢占 | 每个工作区用独立账号 |
| 会话在 DSH 侧栏「未分组」 | 外部 runtime 会话尚未登记进 workspace | 插件 activity/backfill 会补登记；仍异常时看 `sessions` 映射与宿主日志 |

## 8. 多实例与隔离

- 一个 profile 只应加载一个 dsh-im-manager；
- 同一渠道账号不要跨工作区并发绑定（会抢长连接）；
- 每个工作区独立 config/stateDir/HTTP 端口/DSH runtime；工作区之间上下文隔离；
- 当前是逻辑隔离，不是 OS 进程隔离；每个工作区仍会 spawn 自己的 `dsh --profile sdk`。

## 9. 安全运维清单

- [ ] manager HTTP API 与工作区 HTTP 只监听 loopback，不暴露公网（无鉴权/TLS）；
- [ ] `manager.json`、工作区配置、微信凭据均为 `0600`；
- [ ] 密钥用 `env:VAR` 或系统凭据，不写进仓库/聊天记录；
- [ ] 配对批准/allowlist 是特权操作，不在共享屏幕/录屏中操作；
- [ ] 同一账号不跨工作区重复绑定；
- [ ] 卸载/迁移前备份 `~/.dsh-im-manager` 与各工作区 `.dsh-im-manager`。
