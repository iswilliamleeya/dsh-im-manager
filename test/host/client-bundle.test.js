import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

/** Load lib/client.js in a tiny ModuleLoader sandbox. */
function loadClientBundle() {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  let registration = null;
  const react = {
    createElement(tag, props, ...children) {
      return { tag, props: props ?? {}, children };
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(entry) { registration = entry; } } },
    document: undefined,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  assert.ok(registration, 'bundle must register through window.__ModuleLoader__.load');
  assert.equal(registration.id, 'dsh-im-manager');
  const icon = (props) => ({ tag: 'svg', props: props ?? {}, children: [] });
  const primitives = {
    Button: (props) => ({ tag: 'button', props: props ?? {}, children: [] }),
    Input: (props) => ({ tag: 'input', props: props ?? {}, children: [] }),
    IconPlusOutlineRegular: icon,
    IconRefreshOutlineRegular: icon,
    IconChevronRightOutlineRegular: icon,
    IconChevronLeftOutlineMedium: icon,
    IconTrashOutlineRegular: icon,
  };
  const exports = registration.factory((request) => {
    if (request === 'react') return react;
    if (request === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require: ${request}`);
  });
  return { exports, react, primitives, source };
}

/** A fake slots service that runs every inject factory (including generators). */
function fakeSlots() {
  const injected = [];
  const registered = [];
  const slots = {
    inject(name, factory) {
      injected.push(name);
      const value = factory();
      if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
        let step = value.next();
        while (!step.done) step = value.next();
      }
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  };
  return { slots, injected, registered };
}

test('client bundle registers sidebar panel, main page and settings section', async () => {
  const { exports } = loadClientBundle();
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(Array.from(exports.inject), ['slots', 'connection', 'sessions']);

  const { slots, injected, registered } = fakeSlots();
  const refreshed = [];
  const connection = { rpc: { async call() { return { ok: true, value: {} }; } } };
  await exports.apply({
    slots,
    connection,
    sessions: { async refresh() { refreshed.push(Date.now()); } },
    effect: () => {},
  });
  assert.deepEqual(injected, ['sidebar.panellist', 'main']);

  const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist');
  assert.ok(sidebar, 'sidebar.panellist registration missing');
  assert.equal(sidebar.options.id, 'im-manager');
  assert.equal(sidebar.options.order, 5);
  assert.equal(sidebar.options.label(), '消息');
  assert.equal(typeof sidebar.component, 'function');

  const main = registered.find((entry) => entry.options.name === 'main');
  assert.ok(main, 'main page registration missing');
  assert.equal(main.options.key, 'im-manager');
  assert.equal(typeof main.component, 'function');

  assert.equal(registered.some((entry) => entry.options.name === 'settings.section'), false);
});

test('bundle uses the connection RPC channel, not an iframe or fixed manager port', () => {
  const { source } = loadClientBundle();
  assert.match(source, /connection\.rpc\.call\('\/im-manager'/);
  for (const endpoint of ['state', 'activity', 'discover', 'workspace.adopt', 'config.get', 'config.save', 'connect.begin', 'connect.cancel', 'pairing.approve', 'logs', 'workspace.add']) {
    assert.ok(source.includes(`'${endpoint}'`), `missing RPC endpoint ${endpoint}`);
  }
  assert.equal(source.includes('<iframe'), false);
  assert.equal(source.includes("'iframe'"), false);
  assert.equal(source.includes('127.0.0.1:8788'), false);
  // Plugins-style page chrome (dark-mode tokens, list rows, toolbar).
  assert.match(source, /dim-page/);
  assert.match(source, /--dsw-alias-label-primary/);
  assert.match(source, /dim-cardHead/);
});

test('sidebar icon component renders an svg', () => {
  const { exports } = loadClientBundle();
  const { slots, registered } = fakeSlots();
  const connection = { rpc: { async call() { return { ok: true, value: {} }; } } };
  return exports.apply({ slots, connection, sessions: { async refresh() {} }, effect: () => {} }).then(() => {
    const icon = registered.find((entry) => entry.options.name === 'sidebar.panellist').component;
    const tree = icon({ size: 18 });
    assert.equal(tree.tag, 'svg');
    assert.equal(tree.props.width, 18);
  });
});

test('package.json exposes the client half expected by dsh-client-modules', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'));
  assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), false);
});
