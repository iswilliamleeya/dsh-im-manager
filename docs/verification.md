# 验证记录

> 最近更新：2026-10-19（清理 Web UI / 独立 CLI manager 后）。
> 测试命令：`npm test`；全量 **625 通过 / 0 失败 / 48 suites**。

## 1. 结论

- 运行入口统一为 **DSH profile bundle**：host 插件在 DSH 宿主内启动 manager，侧栏「消息」是唯一管理界面；
- 本机 HTTP API 保留（attach/健康检查），**静态 Web UI 与独立 CLI `serve`/`manager`/`init` 已移除**；
- 四渠道（飞书/钉钉/企业微信/个人微信）适配器、manager、会话同步、workspace 发现均有单测/e2e；
- 真实 IM 平台收发需要凭证和手机扫码，自动化只覆盖到 fake adapter / 扫码状态机。

## 2. 测试分布（2026-10-19）

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `npm test` | 625 / 0 / 48 suites |
| CLI e2e（诊断命令） | `node --test test/e2e/cli.e2e.test.js` | 5 / 0 |
| Manager e2e（两工作区 + fake runtime） | `node --test test/e2e/manager.e2e.test.js` | 1 / 0 |
| 客户端 bundle / host RPC | `node --test test/host/*.test.js` | 见全量 |
| Adapter / core / bridge / manager | `node --test 'test/**/*.test.js'` | 见全量 |

已删除的测试：`test/webui/*`（静态 UI 契约）以及 CLI `init`/`serve` 相关用例。

## 3. 真实 DSH 宿主插件验证（非 mock）

隔离 `DSH_HOME` + 真实 `dsh` loader：

```bash
bash install/verify-plugin.sh
```

验证点：

- patch row apply → `manager mode: owned`；
- 提供 `workspaceRegistry`，注册 `/im-manager` RPC；
- manager HTTP `/api/health` 可用；
- dispose 后 lock 释放、manager 停止。

真实 desktop profile 曾验证（2026-10-18）：插件 mounted、manager owned、`dsh` 工作区 autoStart、
`im_gateway_*` 工具可调用、侧栏「消息」出现。当前环境已卸载插件，重新安装后需重启 DSH 复验。

## 4. 原生页面 / 工作区发现（隔离 web profile）

- 列表来自 `ctx.workspaceRegistry`，显示 `default-workspace` +「未创建 Gateway」；
- 详情「创建 Gateway」后 manager 条目生成、渠道行出现（`workspace.adopt`）；
- 钉钉配置弹窗包含 mode/clientId/clientSecret/robotCode/signatureSecret/webhookPath/botUserId；
- 弹窗在右侧主面板内居中（overlay rect = `.dim-page` rect，非整个窗口）；
- 截图：`staging/dsh-im-manager-discovery-list.png`、`staging/dsh-im-manager-discovery-detail.png`、
  `staging/dsh-im-manager-dialog-centered.png`（workspace 根目录，不随包分发）。

## 5. 会话同步 / 归组

- `test/manager/session-activity.test.js`：activity revision、running workspace 过滤；
- `test/host/workspace-attach.test.js`：best-effort attach + 历史 backfill；
- 隔离 profile：activity/attach RPC 注册、backfill 执行；
- 真实 Desktop：新 IM session 已验证会归入对应 workspace；历史会话由插件启动 1.2s 后的
  `sessionQuery` 回填补登记（实现已通过单测，真实环境建议重启后复查）。

## 6. Bundle 安装验证

- 隔离 profile `dsh plugin add <tarball>` 后，profile `dsh.profile.bundles` 包含 `dsh-im-manager`；
- 启动后「插件 → 已安装插件」显示 `dsh-im-manager`；
- tarball `npm pack` 产物约 321KB；
- 首次安装 pnpm 会因飞书 SDK 的 `protobufjs` postinstall 提示 ignored build，需要在插件页允许构建并重试；
  这是 pnpm v11 的供应链策略，不是包本身错误。

## 7. 手动冒烟

```bash
node bin/dsh-im-manager.js version           # 0.2.2，exit 0
node bin/dsh-im-manager.js help              # 打印诊断命令，exit 0
node bin/dsh-im-manager.js doctor --config config/config.example.json
node bin/dsh-im-manager.js weixin status --config config/config.example.json
node bin/dsh-im-manager.js pair 123456       # 需要已有 pairing.json
```

管理路径：

1. 安装 bundle / `activate.sh`；
2. 重启 DSH；
3. 侧栏「消息」→ 选工作区 → 创建 Gateway → 配置渠道；
4. `curl -s http://127.0.0.1:8788/api/health` 应为 `{"ok":true}`；
5. `curl -s http://127.0.0.1:8788/` 应返回服务 JSON（不再有 HTML）。

## 8. 已知未验证 / 风险

| 项 | 说明 | 建议 |
| --- | --- | --- |
| 真实 IM 平台收发 | CI/自动化使用 fake adapter；飞书/钉钉/企微/微信真机需凭证与扫码 | 发布前按 docs/channels 逐渠道冒烟 |
| 微信登录态 | 可能过期/被踢（`-14`） | 重新 `weixin login`；不手动编辑凭据 |
| 多工作区隔离 | 逻辑隔离，不是 OS 进程隔离；每工作区一个 SDK runtime | 视为同宿主高权限组件 |
| 历史会话归组 | backfill 依赖 session header cwd；路径不匹配会跳过 | 重启后检查侧栏；用 `sessions` 诊断 |
| pnpm 构建批准 | 首次安装可能被供应链策略拦截 | 插件页允许 `protobufjs` 构建后重试 |
| 端口/锁 | manager API 默认 8788；多 owner 靠 lock attach | 不要手动绕过锁；不要暴露公网 |
