/**
 * Static contract tests for the channel QR-connect dialog (contract §10).
 *
 * The Web UI has no build step and no DOM test dependency, so these tests pin
 * the shape of index.html / app.js / style.css: the three connect endpoints, the
 * cancel-before-confirmed rule, the Feishu manual tab, the QR data URL usage and
 * the "local resources only" guarantee.
 */
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

/**
 * Extract a top-level function by name using brace counting. Good enough for
 * this dependency-free source (no template literals with unbalanced braces).
 * @param {string} source
 * @param {string} name
 */
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `缺少函数：${name}`);

  // Skip the parameter list first: default parameter objects (e.g. `= {}`) must
  // not be mistaken for the function body.
  let paren = 0;
  let index = start + marker.length - 1;
  for (; index < source.length; index += 1) {
    if (source[index] === '(') paren += 1;
    else if (source[index] === ')') {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  const bodyStart = source.indexOf('{', index);
  assert.notEqual(bodyStart, -1, `函数未闭合：${name}`);
  let depth = 0;
  for (let cursor = bodyStart; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  throw new Error(`函数未闭合：${name}`);
}

describe('webui 扫码连接弹窗（docs/manager-contract.md §10）', () => {
  it('index.html 提供飞书双 tab 弹窗、二维码容器与手动密码字段', async () => {
    const html = await readAsset('index.html');
    for (const id of [
      'connect-dialog',
      'connect-title',
      'connect-tabs',
      'connect-tab-qr',
      'connect-tab-manual',
      'connect-qr-panel',
      'qr-image-slot',
      'qr-placeholder',
      'connect-status',
      'connect-regenerate',
      'connect-cancel',
      'connect-manual-panel',
      'connect-app-id',
      'connect-app-secret',
      'connect-domain',
      'connect-manual-submit',
      'connect-manual-error',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `缺少节点 #${id}`);
    }

    assert.ok(html.includes('扫码创建/登录'), '缺少「扫码创建/登录」tab');
    assert.ok(html.includes('手动填写'), '缺少「手动填写」tab');
    assert.match(html, /<input[^>]*id="connect-app-secret"[^>]*type="password"|<input[^>]*type="password"[^>]*id="connect-app-secret"/);
    assert.match(html, /<select id="connect-domain">/);
    // The QR <img> is created from qr.dataUrl at runtime, never hard-coded.
    assert.doesNotMatch(html, /<img\b/);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  it('app.js 引用 begin / status / cancel 三条 connect 端点', async () => {
    const js = await readAsset('app.js');
    assert.ok(js.includes('/channels/${channel}/connect'));
    assert.ok(js.includes('/channels/${channel}/connect/cancel'));

    const connectPath = extractFunction(js, 'connectPath');
    assert.match(connectPath, /\/channels\/\$\{channel\}\/connect/);
    const cancelPath = extractFunction(js, 'connectCancelPath');
    assert.match(cancelPath, /\/channels\/\$\{channel\}\/connect\/cancel/);

    const begin = extractFunction(js, 'runConnectBegin');
    assert.match(begin, /api\(connectPath\(/);
    assert.match(begin, /method: 'POST'/);
    assert.match(begin, /mode: 'qr'/);

    const poll = extractFunction(js, 'pollConnect');
    assert.match(poll, /api\(connectPath\(/);
    assert.doesNotMatch(poll, /method: 'POST'/);

    const cancel = extractFunction(js, 'cancelConnectFlow');
    assert.match(cancel, /api\(connectCancelPath\(/);
    assert.match(cancel, /method: 'POST'/);
  });

  it('二维码用 qr.dataUrl 渲染 <img>，按 intervalMs（默认 1500）轮询', async () => {
    const js = await readAsset('app.js');
    assert.match(js, /CONNECT_DEFAULT_INTERVAL_MS = 1500/);
    assert.match(js, /flow\.qr/);
    assert.match(js, /dataUrl/);
    assert.match(js, /startsWith\('data:image\/'\)/);

    const apply = extractFunction(js, 'applyConnectFlow');
    assert.match(apply, /dataUrl\.startsWith\('data:image\/'\)/);
    assert.match(apply, /setQrImage\(dataUrl\)/);
    assert.match(apply, /scheduleConnectPoll\(session, flow\.intervalMs\)/);

    const setQr = extractFunction(js, 'setQrImage');
    assert.match(setQr, /document\.createElement\('img'\)/);
    assert.match(setQr, /img\.src = dataUrl/);
    assert.match(setQr, /img\.alt = '登录二维码'/);
  });

  it('expired / failed 显示「重新生成二维码」，confirmed 后 toast + 刷新 + 关闭', async () => {
    const js = await readAsset('app.js');
    assert.ok(js.includes('重新生成二维码'));

    const apply = extractFunction(js, 'applyConnectFlow');
    assert.match(apply, /flow\.state === 'expired' \|\| flow\.state === 'failed'/);
    assert.match(apply, /showRegenerate\(\)/);
    assert.match(apply, /flow\.state === 'confirmed'/);

    const confirmed = extractFunction(js, 'onConnectConfirmed');
    assert.match(confirmed, /toast\(/);
    assert.match(confirmed, /refreshState\(\)/);
    assert.match(confirmed, /loadConfig\(/);
    assert.match(confirmed, /closeConnectDialog\(\)/);
    assert.doesNotMatch(confirmed, /queueCancelFlow|cancelConnectFlow/);

    assert.match(js, /\$\('connect-regenerate'\)\.addEventListener\('click', \(\) => beginConnect\(\)\)/);
  });

  it('confirmed 之前关闭（X / Esc / 遮罩 / 取消）调用 cancel，渠道保持未启用', async () => {
    const js = await readAsset('app.js');
    const close = extractFunction(js, 'closeConnectDialog');
    assert.match(close, /const wasConfirmed = session\.confirmed/);
    assert.match(close, /if \(!wasConfirmed/);
    assert.match(close, /queueCancelFlow\(session\)/);
    assert.ok(close.includes('已取消，渠道未启用'));

    // The cancel request goes through the serialized queue; skip it for confirmed flows.
    const queue = extractFunction(js, 'queueCancelFlow');
    assert.match(queue, /cancelConnectFlow\(session\.workspaceId, session\.channel\)/);

    // X / cancel buttons, backdrop click and native <dialog> Esc all route to close.
    assert.match(js, /\$\('connect-close'\)\.addEventListener\('click', \(\) => closeConnectDialog\(\{ userInitiated: true \}\)\)/);
    assert.match(js, /\$\('connect-cancel'\)\.addEventListener\('click', \(\) => closeConnectDialog\(\{ userInitiated: true \}\)\)/);
    assert.match(js, /\$\('connect-manual-cancel'\)\.addEventListener\('click', \(\) => closeConnectDialog\(\{ userInitiated: true \}\)\)/);
    assert.match(js, /event\.target === connectDialog\) closeConnectDialog\(\{ userInitiated: true \}\)/);
    assert.match(js, /connectDialog\.addEventListener\('cancel', \(event\) => \{\s*event\.preventDefault\(\);\s*closeConnectDialog\(\{ userInitiated: true \}\);/);
  });

  it('飞书手动 tab 读取 config 并 PUT enabled/appId/appSecret/domain；微信只有二维码', async () => {
    const js = await readAsset('app.js');
    const load = extractFunction(js, 'loadManualConfig');
    assert.match(load, /api\(wsPath\(session\.workspaceId, '\/config'\)\)/);
    assert.match(load, /current\.appId/);
    assert.match(load, /current\.appSecret === '\*\*\*'/);
    assert.ok(load.includes('已保存，留空不改'));

    const save = extractFunction(js, 'saveManualConnect');
    assert.match(save, /enabled: true/);
    assert.match(save, /appId/);
    assert.match(save, /appSecret/);
    assert.match(save, /domain/);
    assert.match(save, /method: 'PUT'/);
    assert.match(save, /nextConfig\.channels\.feishu/);
    assert.match(save, /toast\('飞书配置已保存，渠道已启用'/);
    // Failure keeps the dialog open: the catch branch must not close it.
    const catchStart = save.indexOf('} catch (error) {');
    assert.notEqual(catchStart, -1, 'saveManualConnect 缺少失败分支');
    assert.doesNotMatch(save.slice(catchStart), /closeConnectDialog/);

    // Only Feishu has the manual mode; weixin hides the tab row entirely.
    assert.match(js, /mode === 'manual' && session\.channel !== 'feishu'/);
    assert.match(js, /\$\('connect-tabs'\)\.hidden = channelId !== 'feishu'/);
  });

  it('不乐观打开开关：卡片控件只打开弹窗，/config 保存保留已加载的 enabled', async () => {
    const js = await readAsset('app.js');

    const control = extractFunction(js, 'buildConnectControl');
    assert.match(control, /channelConfig\.enabled === true/);
    assert.match(control, /openConnectDialog\(def\.id\)/);
    assert.doesNotMatch(control, /\.checked/);
    assert.doesNotMatch(control, /enabled\s*=\s*true/);

    const form = extractFunction(js, 'readChannelForm');
    assert.match(form, /loaded\.enabled === true/);

    const begin = extractFunction(js, 'runConnectBegin');
    assert.doesNotMatch(begin, /enabled\s*[:=]\s*true/);

    // After QR confirm or manual save the page reloads server truth.
    const confirmed = extractFunction(js, 'onConnectConfirmed');
    assert.match(confirmed, /refreshState\(\)/);
    assert.match(confirmed, /loadConfig\(/);
  });

  it('只允许本地资源：app.js 无外部 URL / import，二维码只接受 data:image/', async () => {
    const [js, css] = await Promise.all([readAsset('app.js'), readAsset('style.css')]);
    assert.doesNotMatch(js, /https?:\/\//);
    assert.doesNotMatch(js, /^\s*import\s/m);
    assert.doesNotMatch(js, /\brequire\s*\(/);
    assert.doesNotMatch(js, /\.innerHTML\s*=/);
    assert.match(js, /startsWith\('data:image\/'\)/);
    assert.match(css, /\.connect-tabs/);
    assert.match(css, /\.qr-image/);
    assert.match(css, /\.connect-status/);
    assert.match(css, /\.channel-connect/);
  });
});
