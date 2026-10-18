import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WEBUI_ROOT = fileURLToPath(new URL('../../src/webui/', import.meta.url));

/** @param {string} name */
async function readAsset(name) {
  return readFile(join(WEBUI_ROOT, name), 'utf8');
}

describe('webui 前端契约（docs/manager-contract.md §5–§6）', () => {
  it('app.js 是原生 ES module：无框架、无 import、用 fetch 轮询 /api/state（2s）', async () => {
    const js = await readAsset('app.js');
    assert.match(js, /POLL_INTERVAL_MS = 2000/);
    assert.match(js, /fetch\(/);
    assert.match(js, /\/api\/state/);
    assert.match(js, /function schedulePoll\(/);
    assert.doesNotMatch(js, /^\s*import\s/m);
    assert.doesNotMatch(js, /\brequire\s*\(/);
    assert.doesNotMatch(js, /\b(?:React|Vue|Angular|Svelte|jQuery)\b/);
  });

  it('app.js 覆盖工作区 CRUD、启停/重启、配置、配对与日志端点', async () => {
    const js = await readAsset('app.js');
    const markers = [
      '/api/workspaces/',
      "runAction('start')",
      "runAction('stop')",
      "runAction('restart')",
      "method: 'DELETE'",
      "method: 'PUT'",
      "method: 'POST'",
      "wsPath(id, '/config')",
      "wsPath(id, '/pairing')",
      "wsPath(id, '/pairing/approve')",
      '/logs?lines=',
      'body: { name, workspaceDir, channels }',
    ];
    for (const marker of markers) {
      assert.ok(js.includes(marker), `缺少契约标记：${marker}`);
    }
  });

  it('四个渠道卡片覆盖关键字段，密钥字段为 type=password', async () => {
    const js = await readAsset('app.js');
    const requiredKeys = [
      'appId',
      'appSecret',
      'domain',
      'clientId',
      'clientSecret',
      'robotCode',
      'botId',
      'secret',
      'token',
      'encodingAESKey',
      'corpId',
      'agentId',
      'credentialsFile',
      'baseUrl',
      'typing',
    ];
    for (const key of requiredKeys) {
      assert.ok(js.includes(`key: '${key}'`), `缺少渠道字段：${key}`);
    }
    for (const id of ['feishu', 'dingtalk', 'wecom', 'weixin']) {
      assert.ok(js.includes(`id: '${id}'`), `缺少渠道：${id}`);
    }
    // Every sensitive field is declared password + secret.
    for (const key of ['appSecret', 'clientSecret', 'encodingAESKey']) {
      const line = js.split('\n').find((entry) => entry.includes(`key: '${key}'`));
      assert.ok(line, `找不到字段行：${key}`);
      assert.match(line, /type: 'password'/);
      assert.match(line, /secret: true/);
    }
    assert.match(js, /type: 'password', secret: true/);
  });

  it('脱敏配置按契约回传：*** 不回显明文，留空保留原值', async () => {
    const js = await readAsset('app.js');
    assert.match(js, /value === '\*\*\*'/);
    assert.ok(js.includes('已保存，留空不改'));
    assert.match(js, /hasOwnProperty\.call\(loaded, field\.key\)/);
    assert.match(js, /nextConfig\.channels\[def\.id\]/);
    assert.ok(js.includes("method: 'PUT'"));
    assert.match(js, /toast\(`\$\{def\.name\}配置已保存/);
  });

  it('状态与操作使用中文文案，删除工作区前 confirm', async () => {
    const js = await readAsset('app.js');
    for (const label of ['运行中', '已停止', '启动中', '停止中', '错误', '开始', '停止', '重启']) {
      assert.ok(js.includes(label), `缺少中文文案：${label}`);
    }
    assert.match(js, /window\.confirm\(/);
    assert.ok(js.includes('删除工作区'));
  });

  it('index.html 提供两栏骨架、toast 区、添加对话框与日志 pre', async () => {
    const html = await readAsset('index.html');
    for (const id of [
      'app',
      'workspace-list',
      'workspace-detail',
      'empty-state',
      'channels-grid',
      'pairing-list',
      'logs-pre',
      'toast-region',
      'add-dialog',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `缺少节点 #${id}`);
    }
    assert.match(html, /<pre id="logs-pre"/);
    assert.match(html, /name="channels"/);
    for (const channel of ['feishu', 'dingtalk', 'wecom', 'weixin']) {
      assert.ok(html.includes(`value="${channel}"`), `添加工单缺少渠道：${channel}`);
    }
    assert.match(html, /<script type="module" src="app\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="style\.css" \/>/);
  });

  it('style.css 含两栏布局、状态色点、卡片、日志和 1024px 响应式', async () => {
    const css = await readAsset('style.css');
    assert.match(css, /grid-template-columns:\s*280px/);
    assert.match(css, /@media\s*\(max-width:\s*1024px\)/);
    assert.match(css, /\.dot-running/);
    assert.match(css, /\.dot-stopped/);
    assert.match(css, /\.dot-error/);
    assert.match(css, /\.channel-card/);
    assert.match(css, /\.logs\s*\{/);
    assert.match(css, /\.toast-error/);
  });

  it('前端不加载外部 CDN / 字体，也不使用 @import', async () => {
    const [html, css] = await Promise.all([readAsset('index.html'), readAsset('style.css')]);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<(?:img|iframe|video|audio)\b/);
    assert.doesNotMatch(css, /@import\s/);
    assert.doesNotMatch(css, /url\(\s*["']?(?:https?:)?\/\//);
    assert.doesNotMatch(css, /@font-face/);
  });

  it('网络错误统一进 toast，轮询失败不破坏页面状态', async () => {
    const js = await readAsset('app.js');
    assert.match(js, /function toast\(/);
    assert.ok(js.includes('无法连接 manager（网络错误）'));
    assert.ok(js.includes('加载渠道配置失败：${error.message}'));
    assert.ok(js.includes('无法获取 manager 状态：${error.message}'));
    assert.match(js, /wasOnline !== false/);
    assert.match(js, /renderManagerStatus\(\)/);
  });
});
