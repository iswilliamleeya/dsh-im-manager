import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Guards the DSH plugin UI spec for the web half:
 *   staging/2026-10-23-plugin-ui-spec/SPEC.md
 * The CSS lives in one template literal inside lib/client.js (no build step),
 * so these assertions run against the shipped artifact.
 */
const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
const css = [...source.matchAll(/`((?:[^`\\]|\\.)*)`/g)]
  .map((match) => match[1])
  .find((block) => block.length > 200 && block.includes('{')) ?? '';

const LADDER = new Map([[11, 14], [12, 18], [13, 20], [14, 22], [16, 24], [20, 28], [24, 32]]);

test('client CSS exists and avoids tokens that DSH does not ship', () => {
  assert.ok(css.length > 1000, 'the plugin CSS template literal must be present');
  assert.equal(source.includes('--dsw-font-mono'), false, 'use --dsh-font-family-code-default instead');
  assert.match(css, /var\(--dsh-font-family-code-default\)/);
});

test('client CSS keeps the desktop top clearance for entrance pages', () => {
  // SPEC §1.7: ui-layout publishes --dsh-frame-top-clearance on the root
  // element; entrance pages must offset their header by it or mac traffic
  // lights / the Windows titlebar cover the page head.
  assert.match(css, /\.dim-pageHead\{[^}]*padding-top:var\(--dim-space-6\)/);
  assert.match(css, /\[data-platform=darwin\] \.dim-pageHead,\[data-windows-titlebar\] \.dim-pageHead\{padding-top:calc\(var\(--dim-space-6\) \+ var\(--dsh-frame-top-clearance,0px\)\)\}/);
  assert.match(css, /\[data-platform=darwin\] \.dim-detailTop,\[data-windows-titlebar\] \.dim-detailTop\{padding-top:calc\(var\(--dim-space-6\) \+ var\(--dsh-frame-top-clearance,0px\)\)\}/);
});

test('client CSS defines the shared --dim-space-* scale', () => {
  const scale = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px', 12: '48px' };
  for (const [name, value] of Object.entries(scale)) {
    assert.ok(source.includes(`--dim-space-${name}:${value}`), `missing --dim-space-${name}:${value}`);
  }
  assert.ok(source.includes('--dim-space-field:14px'), 'missing --dim-space-field:14px');
});

test('client CSS stays on the DSH typography and radius ladders', () => {
  for (const match of css.matchAll(/font-size\s*:\s*([0-9.]+)px/g)) {
    const size = Number(match[1]);
    assert.ok(LADDER.has(size), `font-size ${match[1]}px is outside the DSH ladder`);
  }
  for (const match of css.matchAll(/line-height\s*:\s*([0-9.]+)px/g)) {
    assert.ok([...LADDER.values()].includes(Number(match[1])), `line-height ${match[1]}px is outside the DSH ladder`);
  }
  for (const match of css.matchAll(/border-radius\s*:\s*([^;]+)/g)) {
    const value = match[1].trim();
    const allowed = value.startsWith('var(--dsw-radius-') || value === '50%' || value === '999px';
    assert.ok(allowed, `literal border-radius ${value} must use a --dsw-radius-* token`);
  }
  if (/border-radius\s*:\s*(50%|999px)/.test(css)) {
    assert.match(css, /corner-shape\s*:\s*round/, 'round/pill radii need corner-shape: round');
  }
});

test('client CSS keeps colors tokenised and motion reduced', () => {
  const hexes = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toLowerCase()))];
  // #fff is intentional: the QR code image needs an opaque white plate to scan.
  assert.deepEqual(hexes, ['#fff']);
  assert.equal(/transition\s*:\s*all\b/.test(css), false, 'no transition: all');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('dialogs and async results expose the required a11y contract', () => {
  assert.match(source, /role: 'dialog'/);
  assert.match(source, /'aria-modal': 'true'/);
  assert.match(source, /'aria-labelledby': titleId/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /restore\.focus\(\)/, 'focus must return to the trigger');
  assert.match(source, /role: 'status', 'aria-live': 'polite'/);
  assert.match(source, /'aria-hidden': 'true'/, 'decorative dots must be hidden');
  assert.match(source, /tabIndex: -1/);
});

test('client update UI follows the shared version-update contract', () => {
  for (const endpoint of ['update.state', 'update.check', 'update.install']) {
    assert.ok(source.includes(`'${endpoint}'`), `missing update RPC endpoint ${endpoint}`);
  }
  for (const copy of [
    '检查更新',
    '检查中…',
    '安装中…',
    '已是最新版本（',
    '发现新版本 v',
    '，正在自动下载安装…',
    '已更新到 v',
    '，刷新页面后生效',
    '已安装 v',
    '，重启 DSH 后生效',
    '刷新页面',
    '关闭',
  ]) {
    assert.ok(source.includes(copy), `missing update copy: ${copy}`);
  }
  assert.match(source, /window\.location\.reload\(\)/, 'installed states need a 刷新页面 button');
  assert.match(source, /· 当前版本 v/, 'the intro must append the current version');
  assert.match(source, /1500/, 'installing state must poll every 1.5s');
  assert.equal(source.includes('api.github.com'), false);

  // Toolbar order: 刷新 | 检查更新 | 添加外部工作区.
  const refresh = source.indexOf("'刷新'");
  const check = source.indexOf("'检查更新'");
  const add = source.indexOf("'添加外部工作区'");
  assert.ok(refresh >= 0 && check > refresh && add > check, 'toolbar order must be 刷新 | 检查更新 | 添加外部工作区');

  // The update notice renders after the banner in both the list and detail views.
  const placements = source.match(/banner,\n\s+updateBar,/g) ?? [];
  assert.equal(placements.length, 2, 'update notice must render below the banner in list and detail');
});
