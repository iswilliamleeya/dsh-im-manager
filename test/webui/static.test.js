import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { close, createStaticServer, listen, request } from './helpers.js';

const server = createStaticServer();

before(async () => {
  await listen(server);
});

after(async () => {
  await close(server);
});

describe('webui 静态路由（manager API 契约 §5）', () => {
  it('GET / 返回 index.html，含 #app 根节点与中文标题', async () => {
    const res = await request(server, '/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html; charset=utf-8$/);
    assert.equal((res.body.match(/id="app"/g) || []).length, 1);
    assert.match(res.body, /<html lang="zh-CN">/);
    assert.match(res.body, /<meta charset="utf-8"/);
    assert.match(res.body, /<title>DSH IM Gateway · 工作区管理<\/title>/);
  });

  it('GET / 只引用本地 app.js / style.css，无外部 CDN', async () => {
    const res = await request(server, '/');
    assert.equal(res.status, 200);

    const refs = [...res.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(refs.sort(), ['app.js', 'style.css']);
    for (const ref of refs) {
      assert.doesNotMatch(ref, /^(?:https?:)?\/\//, `引用了外部资源：${ref}`);
      assert.doesNotMatch(ref, /^(?:data|mailto|javascript):/, `引用了非本地协议：${ref}`);
    }
    assert.match(res.body, /<script type="module" src="app\.js"><\/script>/);
    assert.match(res.body, /<link rel="stylesheet" href="style\.css" \/>/);
    assert.doesNotMatch(res.body, /https?:\/\//);
  });

  it('GET /app.js 返回 JavaScript 内容类型与 ES module 代码', async () => {
    const res = await request(server, '/app.js');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/javascript; charset=utf-8$/);
    assert.match(res.body, /\/api\/state/);
    assert.match(res.body, /POLL_INTERVAL_MS = 2000/);
    assert.doesNotMatch(res.body, /\brequire\s*\(/);
    assert.doesNotMatch(res.body, /import\s+[^;]*from\s+["'](?:https?:)?\/\//);
  });

  it('GET /style.css 返回 CSS 内容类型与 280px 侧栏', async () => {
    const res = await request(server, '/style.css');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/css; charset=utf-8$/);
    assert.match(res.body, /grid-template-columns:\s*280px/);
  });

  it('GET /style.css 包含 1024px 响应式断点', async () => {
    const res = await request(server, '/style.css');
    assert.match(res.body, /@media\s*\(max-width:\s*1024px\)/);
  });

  it('GET /index.html 与 GET / 返回同一页面', async () => {
    const res = await request(server, '/index.html');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html/);
    assert.match(res.body, /id="app"/);
  });

  it('未知路径返回 404，且不泄露仓库文件', async () => {
    const res = await request(server, '/package.json');
    assert.equal(res.status, 404);
    assert.match(String(res.headers['content-type']), /^text\/plain/);
    assert.doesNotMatch(res.body, /dsh-im-manager/);
  });

  it('拒绝 ../ 路径穿越并返回 404', async () => {
    const res = await request(server, '/../package.json');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, /"name"\s*:\s*"dsh-im-manager"/);
  });

  it('拒绝 URL 编码的路径穿越并返回 404', async () => {
    const attempts = ['/%2e%2e/package.json', '/..%2Fpackage.json', '/%2e%2e%2fsrc%2fwebui%2fapp.js'];
    for (const path of attempts) {
      const res = await request(server, path);
      assert.equal(res.status, 404, `${path} 应返回 404`);
      assert.doesNotMatch(res.body, /dsh-im-manager/);
    }
  });

  it('忽略查询串并按扩展名返回正确类型', async () => {
    const res = await request(server, '/app.js?v=1');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.match(res.body, /init\(\);/);
  });

  it('HEAD / 返回响应头且响应体为空', async () => {
    const res = await request(server, '/', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.ok(Number(res.headers['content-length']) > 0);
  });

  it('不支持的方法返回 404', async () => {
    const res = await request(server, '/', { method: 'POST' });
    assert.equal(res.status, 404);
  });
});
