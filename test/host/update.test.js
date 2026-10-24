import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CHECK_TTL_MS,
  buildGithubSpec,
  compareVersions,
  createUpdateService,
  normalizeVersion,
  parseAtomEntries,
  parseRepoSlug,
  selectLatest,
} from '../../src/host/update.js';

// ── Fixtures (shapes copied from the real GitHub Atom feeds) ────────────────

const TAGS_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <title>Tags from dsh-im-manager</title>
  <entry>
    <id>tag:github.com,2008:Repository/1424550688/v0.2.2</id>
    <updated>2026-10-24T15:43:12Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.2"/>
    <title>v0.2.2</title>
    <content></content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1424550688/v0.2.1</id>
    <updated>2026-10-23T08:32:36Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.1"/>
    <title>v0.2.1</title>
    <content></content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1424550688/v0.2.0</id>
    <updated>2026-10-18T16:59:42Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.0"/>
    <title>dsh-im-manager 0.2.0 — cleanup release</title>
    <content></content>
  </entry>
</feed>`;

const RELEASES_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <title>Release notes from dsh-im-manager</title>
  <entry>
    <id>tag:github.com,2008:Repository/1424550688/v0.2.2</id>
    <updated>2026-10-24T15:43:12Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.2"/>
    <title>v0.2.2</title>
    <content type="html">&lt;p&gt;dsh-im-manager 0.2.2 — 放宽 peer 范围，可在 DSH 0.2.1-rc.3+ 安装&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1424550688/v0.2.0</id>
    <updated>2026-10-18T16:59:42Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.0"/>
    <title>dsh-im-manager 0.2.0 — cleanup release</title>
    <content type="html">&lt;p&gt;Cleanup release.&lt;/p&gt;</content>
  </entry>
</feed>`;

const LS_REMOTE_OUTPUT = [
  '631de4a5a72236bab4869b0bde8d4a4fb3d3ab86\trefs/tags/v0.1.0',
  'f098caf532a52330fea4143c614cbf1ea6c2201d\trefs/tags/v0.1.0^{}',
  'a6925646ae2b574a644a79f9a70b0f6693af061d\trefs/tags/v0.2.1',
  '9212ee92b0163605328343ff8b0d73aacbee3adf\trefs/tags/v0.2.1^{}',
  '7a1c6013e3bd29e098378abeb637a08f97ac2870\trefs/tags/v0.2.2',
  'ea7888e9b428141151270b31fb92bbd425c54926\trefs/tags/v0.2.2^{}',
].join('\n');

const SLUG = 'iswilliamleeya/dsh-im-manager';
const TAGS_URL = `https://github.com/${SLUG}/tags.atom`;
const RELEASES_URL = `https://github.com/${SLUG}/releases.atom`;

/** @param {Record<string, string | Error | (() => string | Promise<string>)>} routes */
function fakeFetch(routes = {}) {
  const calls = [];
  /** @type {any} */
  const impl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route();
    return route;
  };
  impl.calls = calls;
  return impl;
}

/** @param {import('node:test').TestContext} t */
function createHarness(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = overrides.statePath ?? join(dir, 'im-manager-update.json');
  let version = overrides.currentVersion ?? '0.2.1';
  const fetchImpl = overrides.fetchImpl ?? fakeFetch({
    [TAGS_URL]: TAGS_ATOM,
    [RELEASES_URL]: RELEASES_ATOM,
  });
  const service = createUpdateService({
    repo: SLUG,
    readVersion: () => version,
    readPackage: () => ({
      name: 'dsh-im-manager',
      version,
      repository: { url: 'git+https://github.com/iswilliamleeya/dsh-im-manager.git' },
    }),
    statePath,
    now: overrides.now,
    fetchImpl,
    lsRemote: overrides.lsRemote ?? (async () => { throw new Error('git unavailable'); }),
    pluginManager: overrides.pluginManager,
    ctx: overrides.ctx,
  });
  return {
    service,
    statePath,
    fetchImpl,
    dir,
    setVersion: (next) => { version = next; },
    getVersion: () => version,
  };
}

/** @param {() => boolean | Promise<boolean>} predicate @param {number} [timeoutMs] */
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: timed out');
}

/** @param {string} path */
function readStateFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** A deferred installBundle result so tests can observe the in-flight state. */
function deferred() {
  /** @type {(value?: any) => void} */
  let resolve;
  /** @type {(reason?: any) => void} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

test('parseRepoSlug accepts the real package.json shapes and rejects non-GitHub', () => {
  assert.equal(parseRepoSlug({ repository: { url: 'git+https://github.com/iswilliamleeya/dsh-im-manager.git' } }), SLUG);
  assert.equal(parseRepoSlug({ repository: { url: 'https://github.com/iswilliamleeya/dsh-im-manager' } }), SLUG);
  assert.equal(parseRepoSlug({ repository: { url: 'git@github.com:iswilliamleeya/dsh-im-manager.git' } }), SLUG);
  assert.equal(parseRepoSlug({ repository: 'git://github.com/iswilliamleeya/dsh-im-manager.git' }), SLUG);
  assert.equal(parseRepoSlug({ repository: { url: 'https://gitlab.com/iswilliamleeya/dsh-im-manager.git' } }), null);
  assert.equal(parseRepoSlug({ repository: { url: 'https://github.com/only-owner' } }), null);
  assert.equal(parseRepoSlug({}), null);
  assert.equal(parseRepoSlug(null), null);
});

test('normalizeVersion only accepts semver tags', () => {
  assert.equal(normalizeVersion('v0.3.3'), '0.3.3');
  assert.equal(normalizeVersion('0.3.3'), '0.3.3');
  assert.equal(normalizeVersion('v0.4.0-rc.1'), '0.4.0-rc.1');
  assert.equal(normalizeVersion(' v0.3.3 '), '0.3.3');
  assert.equal(normalizeVersion('v1.2'), null);
  assert.equal(normalizeVersion('v1.2.3.4'), null);
  assert.equal(normalizeVersion('dsh-im-manager 0.2.0 — cleanup release'), null);
  assert.equal(normalizeVersion(''), null);
  assert.equal(normalizeVersion(null), null);
});

test('compareVersions is semver-correct (0.10.0 > 0.9.0, rc < release)', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0', '0.4.0-rc.1'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.throws(() => compareVersions('nope', '1.0.0'), TypeError);
});

test('parseAtomEntries takes the tag from <id>/<link>, never from <title>', () => {
  const entries = parseAtomEntries(TAGS_ATOM);
  assert.equal(entries.length, 3);
  const zero = entries.find((entry) => entry.version === '0.2.0');
  assert.equal(zero.tag, 'v0.2.0');
  assert.equal(zero.url, 'https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.0');
  assert.equal(zero.updatedAt, '2026-10-18T16:59:42Z');
  // GitHub writes release titles into <title> for old tags; they must not win.
  assert.equal(entries.some((entry) => entry.tag.includes('cleanup')), false);
  assert.deepEqual(entries.map((entry) => entry.tag), ['v0.2.2', 'v0.2.1', 'v0.2.0']);

  const linkOnly = `<feed><entry>
    <id>tag:github.com,2008:Repository/1/v1.2.0</id>
    <link rel="alternate" href="https://github.com/o/r/tags/v1.2.0"/>
    <title>Some unrelated release title</title>
    <content type="html">&lt;p&gt;hello &amp; world&lt;/p&gt;</content>
  </entry></feed>`;
  const [single] = parseAtomEntries(linkOnly);
  assert.equal(single.tag, 'v1.2.0');
  assert.equal(single.version, '1.2.0');
  assert.equal(single.notes, 'hello & world');

  const longNotes = `<feed><entry><id>tag:github.com,2008:Repository/1/v1.0.0</id>
    <title>v1.0.0</title><content>${'x'.repeat(800)}</content></entry></feed>`;
  assert.equal(parseAtomEntries(longNotes)[0].notes.length, 600);
});

test('parseAtomEntries extracts link tags when no <id> is present', () => {
  const xml = `<feed><entry>
    <link rel="alternate" href="https://github.com/o/r/releases/tag/v2.0.0"/>
    <title>release 2</title>
  </entry></feed>`;
  assert.deepEqual(parseAtomEntries(xml).map((entry) => entry.tag), ['v2.0.0']);
});

test('selectLatest takes the max stable version and can include prereleases', () => {
  const entries = [
    { tag: 'v0.9.0', version: '0.9.0', url: 'u9', updatedAt: null, notes: '' },
    { tag: 'v0.10.0', version: '0.10.0', url: 'u10', updatedAt: null, notes: '' },
    { tag: 'v0.11.0-rc.1', version: '0.11.0-rc.1', url: 'urc', updatedAt: null, notes: '' },
    { tag: 'dsh-im-manager 0.2.0 — cleanup release', version: null, url: null, updatedAt: null, notes: '' },
  ];
  assert.equal(selectLatest(entries).version, '0.10.0');
  assert.equal(selectLatest(entries, { includePrerelease: true }).version, '0.11.0-rc.1');
  assert.equal(selectLatest([]), null);
  assert.equal(selectLatest([{ tag: 'nope', version: null }]), null);
});

test('buildGithubSpec builds the plugin-manager spec', () => {
  assert.equal(buildGithubSpec(SLUG, 'v0.2.3'), 'github:iswilliamleeya/dsh-im-manager#v0.2.3');
  assert.throws(() => buildGithubSpec('', 'v1.0.0'), TypeError);
  assert.throws(() => buildGithubSpec(SLUG, ''), TypeError);
});

// ── check ───────────────────────────────────────────────────────────────────

test('check prefers tags.atom, enriches notes from releases.atom and persists available', async (t) => {
  const harness = createHarness(t);
  const result = await harness.service.check();
  assert.equal(result.packageName, 'dsh-im-manager');
  assert.equal(result.repo, SLUG);
  assert.equal(result.currentVersion, '0.2.1');
  assert.equal(result.latestVersion, '0.2.2');
  assert.equal(result.hasUpdate, true);
  assert.equal(result.tag, 'v0.2.2');
  assert.equal(result.source, 'tag');
  assert.equal(result.releaseUrl, 'https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.2');
  assert.match(result.notes, /放宽 peer 范围/);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));

  // tags.atom first, then only the optional notes fetch.
  assert.deepEqual(harness.fetchImpl.calls, [TAGS_URL, RELEASES_URL]);
  assert.equal(harness.fetchImpl.calls.some((url) => url.includes('api.github.com')), false);

  const persisted = readStateFile(harness.statePath);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.status, 'available');
  assert.equal(persisted.latestVersion, '0.2.2');
  assert.equal(persisted.tag, 'v0.2.2');
  assert.equal(persisted.source, 'tag');
  assert.equal(persisted.message, '发现新版本 v0.2.2');
  assert.equal(statSync(harness.statePath).mode & 0o777, 0o600);
  assert.deepEqual(result.state, persisted);
});

test('check reports up to date when the installed version is the latest', async (t) => {
  const harness = createHarness(t, { currentVersion: '0.2.2' });
  const result = await harness.service.check();
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, '0.2.2');
  const persisted = readStateFile(harness.statePath);
  assert.equal(persisted.status, 'up_to_date');
  assert.equal(persisted.message, '已是最新版本（v0.2.2）');
});

test('check skips prereleases unless the installed version is one', async (t) => {
  const xml = `<feed>
    <entry><id>tag:github.com,2008:Repository/1/v0.3.0</id><title>v0.3.0</title></entry>
    <entry><id>tag:github.com,2008:Repository/1/v0.4.0-rc.1</id><title>v0.4.0-rc.1</title></entry>
  </feed>`;
  const fetchImpl = fakeFetch({ [TAGS_URL]: xml, [RELEASES_URL]: '<feed></feed>' });
  const stable = createHarness(t, { currentVersion: '0.2.2', fetchImpl });
  assert.equal((await stable.service.check()).latestVersion, '0.3.0');

  const preFetch = fakeFetch({ [TAGS_URL]: xml, [RELEASES_URL]: '<feed></feed>' });
  const prerelease = createHarness(t, { currentVersion: '0.3.0-rc.0', fetchImpl: preFetch });
  const result = await prerelease.service.check();
  assert.equal(result.latestVersion, '0.4.0-rc.1');
  assert.equal(result.hasUpdate, true);
});

test('check falls back to git ls-remote when tags.atom fails', async (t) => {
  const fetchImpl = fakeFetch({
    [TAGS_URL]: new Error('HTTP 502'),
    [RELEASES_URL]: new Error('HTTP 000'),
  });
  const lsRemote = async (slug) => {
    assert.equal(slug, SLUG);
    return LS_REMOTE_OUTPUT;
  };
  const harness = createHarness(t, { fetchImpl, lsRemote });
  const result = await harness.service.check();
  assert.equal(result.source, 'git');
  assert.equal(result.latestVersion, '0.2.2');
  assert.equal(result.tag, 'v0.2.2');
  assert.equal(result.releaseUrl, 'https://github.com/iswilliamleeya/dsh-im-manager/releases/tag/v0.2.2');
  assert.equal(result.notes, '');
  assert.equal(readStateFile(harness.statePath).source, 'git');
});

test('check falls back to releases.atom when tags.atom and git both fail', async (t) => {
  const fetchImpl = fakeFetch({
    [TAGS_URL]: new Error('HTTP 502'),
    [RELEASES_URL]: RELEASES_ATOM,
  });
  const lsRemote = async () => {
    throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  };
  const harness = createHarness(t, { fetchImpl, lsRemote });
  const result = await harness.service.check();
  assert.equal(result.source, 'release');
  assert.equal(result.latestVersion, '0.2.2');
  assert.match(result.notes, /放宽 peer 范围/);
  assert.equal(harness.fetchImpl.calls.filter((url) => url === RELEASES_URL).length, 1);
});

test('check throws UPDATE_CHECK_FAILED with all three reasons and persists error', async (t) => {
  const fetchImpl = fakeFetch({
    [TAGS_URL]: new Error('HTTP 502'),
    [RELEASES_URL]: new Error('HTTP 000'),
  });
  const lsRemote = async () => { throw new Error('git unavailable'); };
  const harness = createHarness(t, { fetchImpl, lsRemote });
  await assert.rejects(harness.service.check(), (error) => {
    assert.equal(error.code, 'UPDATE_CHECK_FAILED');
    assert.match(error.message, /tags\.atom/);
    assert.match(error.message, /git ls-remote/);
    assert.match(error.message, /releases\.atom/);
    assert.ok(error.message.length <= 300);
    return true;
  });
  const persisted = readStateFile(harness.statePath);
  assert.equal(persisted.status, 'error');
  assert.equal(persisted.error.code, 'UPDATE_CHECK_FAILED');
});

test('check throws REPO_UNKNOWN when repository.url is not GitHub', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'im-manager-update.json');
  const service = createUpdateService({
    repo: null,
    readVersion: () => '0.2.1',
    readPackage: () => ({ name: 'dsh-im-manager', version: '0.2.1', repository: { url: 'https://gitlab.com/a/b.git' } }),
    statePath,
    fetchImpl: fakeFetch({}),
  });
  await assert.rejects(service.check(), (error) => {
    assert.equal(error.code, 'REPO_UNKNOWN');
    assert.match(error.message, /repository\.url/);
    return true;
  });
  assert.equal(readStateFile(statePath).status, 'error');
  assert.equal(readStateFile(statePath).error.code, 'REPO_UNKNOWN');
});

test('check rejects a concurrent check with UPDATE_BUSY', async (t) => {
  const gate = deferred();
  const fetchImpl = async (url) => {
    if (url === TAGS_URL) return gate.promise;
    return RELEASES_ATOM;
  };
  const harness = createHarness(t, { fetchImpl });
  const first = harness.service.check();
  await assert.rejects(harness.service.check(), (error) => error.code === 'UPDATE_BUSY');
  gate.resolve(TAGS_ATOM);
  await first;
});

// ── install ────────────────────────────────────────────────────────────────

test('install runs github:<slug>#<tag> in the background and persists installed', async (t) => {
  const calls = [];
  const pluginManager = {
    async installBundle(spec, options) {
      calls.push({ spec, options });
      harness.setVersion('0.2.2');
      return { application: 'applied', stage: 'applied' };
    },
  };
  const harness = createHarness(t, { pluginManager: { get: () => pluginManager } });
  assert.equal((await harness.service.getState()).autoInstall, true);
  await harness.service.check();

  const started = await harness.service.install();
  assert.equal(started.started, true);
  assert.equal(started.alreadyRunning, false);
  assert.equal(started.state.status, 'installing');
  assert.equal(started.state.startedAt !== null, true);
  assert.equal(started.state.message, '发现新版本 v0.2.2，正在自动下载安装…');
  assert.equal(readStateFile(harness.statePath).status, 'installing');

  await waitFor(async () => (await harness.service.getState()).state.status === 'installed');
  assert.deepEqual(calls, [{ spec: `github:${SLUG}#v0.2.2`, options: {} }]);
  const result = await harness.service.getState();
  assert.equal(result.currentVersion, '0.2.2');
  assert.equal(result.state.status, 'installed');
  assert.equal(result.state.message, '已更新到 v0.2.2，刷新页面后生效');
  assert.equal(result.state.error, null);
  const persisted = readStateFile(harness.statePath);
  assert.equal(persisted.status, 'installed');
  assert.equal(persisted.finishedAt !== null, true);
});

test('install maps restart-required to its message', async (t) => {
  const pluginManager = {
    async installBundle() {
      harness.setVersion('0.2.2');
      return { application: 'restart-required' };
    },
  };
  const harness = createHarness(t, { pluginManager });
  await harness.service.check();
  await harness.service.install();
  await waitFor(async () => (await harness.service.getState()).state.status === 'restart_required');
  const result = await harness.service.getState();
  assert.equal(result.state.message, '已安装 v0.2.2，重启 DSH 后生效');
});

test('install maps failures to a readable error state', async (t) => {
  const pluginManager = {
    async installBundle() {
      return {
        application: 'failed',
        error: { code: 'incompatible-version', message: 'peer dependency mismatch' },
        packageResult: { output: '\u001b[31mpnpm ERR!\u001b[0m  boom' },
      };
    },
  };
  const harness = createHarness(t, { pluginManager });
  await harness.service.check();
  await harness.service.install();
  await waitFor(async () => (await harness.service.getState()).state.status === 'error');
  const result = await harness.service.getState();
  assert.match(result.state.message, /peer dependency mismatch/);
  assert.match(result.state.message, /该版本与当前 DSH 不兼容/);
  assert.equal(result.state.error.code, 'AUTO_INSTALL_FAILED');

  // A rejected installBundle also lands in the error state.
  const rejecting = {
    async installBundle() { throw new Error('network down'); },
  };
  const second = createHarness(t, { pluginManager: rejecting });
  await second.service.check();
  await second.service.install();
  await waitFor(async () => (await second.service.getState()).state.status === 'error');
  assert.match((await second.service.getState()).state.error.message, /network down/);
});

test('install trims the packageResult output tail when no error message exists', async (t) => {
  const pluginManager = {
    async installBundle() {
      return { application: 'failed', packageResult: { output: `${'noise '.repeat(200)}  final failure line` } };
    },
  };
  const harness = createHarness(t, { pluginManager });
  await harness.service.check();
  await harness.service.install();
  await waitFor(async () => (await harness.service.getState()).state.status === 'error');
  const message = (await harness.service.getState()).state.error.message;
  assert.match(message, /final failure line$/);
  assert.ok(message.length <= 800);
});

test('install surfaces ERR_PNPM_IGNORED_BUILDS with an actionable hint and no Progress noise', async (t) => {
  const output = [
    'Progress: resolved 1, reused 0, downloaded 0, added 0',
    'Progress: resolved 27, reused 0, downloaded 0, added 0',
    '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs, esbuild.',
    '',
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  ].join('\n');
  const pluginManager = {
    async installBundle() {
      return { application: 'failed', packageResult: { output } };
    },
  };
  const harness = createHarness(t, { pluginManager });
  await harness.service.check();
  await harness.service.install();
  await waitFor(async () => (await harness.service.getState()).state.status === 'error');
  const state = (await harness.service.getState()).state;
  assert.equal(state.error.code, 'AUTO_INSTALL_FAILED');
  assert.match(state.message, /ERR_PNPM_IGNORED_BUILDS/);
  assert.match(state.message, /Ignored build scripts: protobufjs, esbuild\./);
  assert.match(state.message, /依赖需要允许构建脚本：请到 DSH『插件』页允许这些脚本后重试检查更新/);
  assert.equal(state.message.includes('Progress:'), false);
});

test('regular install failures keep the old behavior (tail fallback, error message priority)', async (t) => {
  // No ERR_PNPM/ERROR lines: keep the last-800-characters fallback unchanged.
  const noisy = `${'Progress: resolved 1, reused 0 '.repeat(50)}  final line: exit code 1`;
  const noisyManager = {
    async installBundle() {
      return { application: 'failed', packageResult: { output: noisy } };
    },
  };
  const noisyHarness = createHarness(t, { pluginManager: noisyManager });
  await noisyHarness.service.check();
  await noisyHarness.service.install();
  await waitFor(async () => (await noisyHarness.service.getState()).state.status === 'error');
  const noisyMessage = (await noisyHarness.service.getState()).state.error.message;
  assert.match(noisyMessage, /final line: exit code 1$/);
  assert.ok(noisyMessage.length <= 800);
  assert.equal(noisyMessage.includes('依赖需要允许构建脚本'), false);

  // A structured error.message still wins over the raw pnpm output, and no
  // ignored-builds hint is added when that output has nothing to do with it.
  const structuredManager = {
    async installBundle() {
      return {
        application: 'failed',
        error: { code: 'incompatible-version', message: 'peer dependency mismatch' },
        packageResult: { output: '[ERR_PNPM_UNSUPPORTED_ENGINE] unsupported engine' },
      };
    },
  };
  const structuredHarness = createHarness(t, { pluginManager: structuredManager });
  await structuredHarness.service.check();
  await structuredHarness.service.install();
  await waitFor(async () => (await structuredHarness.service.getState()).state.status === 'error');
  const structuredMessage = (await structuredHarness.service.getState()).state.error.message;
  assert.match(structuredMessage, /^peer dependency mismatch/);
  assert.equal(structuredMessage.includes('ERR_PNPM_UNSUPPORTED_ENGINE'), false);
  assert.match(structuredMessage, /该版本与当前 DSH 不兼容/);
  assert.equal(structuredMessage.includes('依赖需要允许构建脚本'), false);
});

test('install throws NO_UPDATE when the version is current', async (t) => {
  const harness = createHarness(t, { currentVersion: '0.2.2' });
  await harness.service.check();
  await assert.rejects(harness.service.install(), (error) => {
    assert.equal(error.code, 'NO_UPDATE');
    assert.equal(error.message, '当前没有可安装的更新');
    return true;
  });
  assert.equal(readStateFile(harness.statePath).status, 'up_to_date');
});

test('install throws AUTO_INSTALL_UNAVAILABLE when pluginManager is missing', async (t) => {
  const harness = createHarness(t);
  await harness.service.check();
  await assert.rejects(harness.service.install(), (error) => {
    assert.equal(error.code, 'AUTO_INSTALL_UNAVAILABLE');
    assert.match(error.message, /pluginManager/);
    assert.match(error.message, new RegExp(`github:${SLUG.replace('/', '\\/')}#v0\\.2\\.2`));
    return true;
  });
  // Nothing was installed, so the persisted check result is untouched.
  assert.equal(readStateFile(harness.statePath).status, 'available');
  assert.equal((await harness.service.getState()).autoInstall, false);
});

test('install re-checks when the persisted available result is older than 10 minutes', async (t) => {
  let current = new Date('2026-10-25T00:00:00.000Z');
  const pluginManager = {
    async installBundle() {
      harness.setVersion('0.2.2');
      return { application: 'applied' };
    },
  };
  const harness = createHarness(t, { pluginManager, now: () => current });
  await harness.service.check();
  assert.equal(harness.fetchImpl.calls.filter((url) => url === TAGS_URL).length, 1);

  current = new Date(Date.parse('2026-10-25T00:00:00.000Z') + CHECK_TTL_MS + 60_000);
  const started = await harness.service.install();
  assert.equal(started.started, true);
  assert.equal(harness.fetchImpl.calls.filter((url) => url === TAGS_URL).length, 2);
  await waitFor(async () => (await harness.service.getState()).state.status === 'installed');
});

test('install returns alreadyRunning for a second install and holds UPDATE_BUSY', async (t) => {
  const gate = deferred();
  const pluginManager = {
    installBundle: () => gate.promise,
  };
  const harness = createHarness(t, { pluginManager });
  await harness.service.check();
  const first = await harness.service.install();
  assert.equal(first.started, true);
  const second = await harness.service.install();
  assert.equal(second.started, false);
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.state.status, 'installing');
  await assert.rejects(harness.service.check(), (error) => error.code === 'UPDATE_BUSY');
  gate.resolve({ application: 'applied' });
  await waitFor(async () => (await harness.service.getState()).state.status === 'installed');
});

test('install prefers the persisted available result without re-checking', async (t) => {
  const pluginManager = {
    async installBundle() {
      harness.setVersion('0.2.2');
      return { application: 'applied' };
    },
  };
  const harness = createHarness(t, { pluginManager });
  await harness.service.check();
  const tagsCalls = harness.fetchImpl.calls.filter((url) => url === TAGS_URL).length;
  await harness.service.install();
  assert.equal(harness.fetchImpl.calls.filter((url) => url === TAGS_URL).length, tagsCalls);
  await waitFor(async () => (await harness.service.getState()).state.status === 'installed');
});

// ── state persistence and recovery ─────────────────────────────────────────

test('state tolerates a corrupt state file and reports autoInstall', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'im-manager-update.json');
  writeFileSync(statePath, '{not json', 'utf8');
  const harness = createHarness(t, { statePath });
  const result = await harness.service.getState();
  assert.equal(result.state.status, 'idle');
  assert.equal(result.currentVersion, '0.2.1');
  assert.equal(result.repo, SLUG);
  assert.equal(result.autoInstall, false);
});

test('update.state recovers a stale installing state left by an HMR reload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'im-manager-update.json');
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    status: 'installing',
    currentVersion: '0.2.1',
    latestVersion: '0.2.2',
    tag: 'v0.2.2',
    startedAt: '2026-10-25T00:50:00.000Z',
    finishedAt: null,
    message: '发现新版本 v0.2.2，正在自动下载安装…',
    error: null,
  }), 'utf8');
  // The package on disk already reached the target version: treat as installed.
  const harness = createHarness(t, {
    statePath,
    currentVersion: '0.2.2',
    now: () => new Date('2026-10-25T01:00:00.000Z'),
  });
  const result = await harness.service.getState();
  assert.equal(result.state.status, 'installed');
  assert.equal(result.state.message, '已更新到 v0.2.2，刷新页面后生效');
  assert.equal(readStateFile(statePath).status, 'installed');
});

test('update.state reports an interrupted install when the version did not move', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'im-manager-update.json');
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    status: 'installing',
    currentVersion: '0.2.1',
    latestVersion: '0.2.2',
    tag: 'v0.2.2',
    startedAt: '2026-10-25T00:50:00.000Z',
    finishedAt: null,
    message: '发现新版本 v0.2.2，正在自动下载安装…',
    error: null,
  }), 'utf8');
  const harness = createHarness(t, {
    statePath,
    currentVersion: '0.2.1',
    now: () => new Date('2026-10-25T01:00:00.000Z'),
  });
  const result = await harness.service.getState();
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.error.code, 'INSTALL_INTERRUPTED');
});

test('state file is written atomically and stays private', async (t) => {
  const harness = createHarness(t);
  await harness.service.check();
  const persisted = readStateFile(harness.statePath);
  assert.equal(persisted.version, 1);
  assert.equal(statSync(harness.statePath).mode & 0o777, 0o600);
});

test('service never touches api.github.com and the host is injectable end to end', async (t) => {
  const harness = createHarness(t);
  await harness.service.check();
  assert.equal(harness.fetchImpl.calls.some((url) => url.includes('api.github.com')), false);
  await harness.service.getState();
});
