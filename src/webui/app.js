/**
 * DSH IM Gateway — manager Web UI (no build step, native ES module).
 *
 * Talks to the manager HTTP API frozen in docs/manager-contract.md §5:
 *   GET    /api/state
 *   POST   /api/workspaces
 *   DELETE /api/workspaces/:id
 *   POST   /api/workspaces/:id/{start,stop,restart}
 *   GET    /api/workspaces/:id/config
 *   PUT    /api/workspaces/:id/config
 *   GET    /api/workspaces/:id/pairing
 *   POST   /api/workspaces/:id/pairing/approve
 *   GET    /api/workspaces/:id/logs?lines=200
 *
 * Channel QR connect (contract §10):
 *   POST   /api/workspaces/:id/channels/:channel/connect        { mode: 'qr' }
 *   GET    /api/workspaces/:id/channels/:channel/connect        poll flow state
 *   POST   /api/workspaces/:id/channels/:channel/connect/cancel cancel flow
 *
 * All dynamic values are rendered with textContent / input.value (never
 * innerHTML), so names, paths and log lines cannot inject markup.
 */

const POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const LOG_LINES = 200;

/** Channels that enable themselves through the QR connect flow (contract §10). */
const CONNECT_CHANNEL_IDS = ['feishu', 'weixin'];
const CONNECT_DEFAULT_INTERVAL_MS = 1500;
const CONNECT_MIN_INTERVAL_MS = 500;
const CONNECT_MAX_INTERVAL_MS = 10_000;

const CONNECT_STATE_META = {
  pending: { label: '等待扫码…', kind: 'pending' },
  scanned: { label: '已扫码，请在手机上确认', kind: 'scanned' },
  confirmed: { label: '已确认，渠道已启用', kind: 'success' },
  expired: { label: '二维码已过期', kind: 'error' },
  failed: { label: '连接失败', kind: 'error' },
  cancelled: { label: '连接已取消', kind: 'muted' },
};

const CHANNEL_DEFS = [
  {
    id: 'feishu',
    name: '飞书',
    glyph: '飞',
    note: '启用请点右上角「启用」：扫码创建/登录，或手动填写 App ID / Secret。以下字段保存不会改变启用状态。',
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_ 开头的应用 ID' },
      { key: 'appSecret', label: 'App Secret', type: 'password', secret: true, placeholder: '应用密钥' },
      {
        key: 'domain',
        label: 'Domain',
        type: 'select',
        options: [
          ['feishu', 'feishu（中国版）'],
          ['lark', 'lark（国际版）'],
        ],
      },
      {
        key: 'mode',
        label: '连接模式',
        type: 'select',
        options: [
          ['ws', '长连接 ws'],
          ['webhook', 'Webhook'],
        ],
      },
    ],
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    glyph: '钉',
    note: 'stream 模式必填 clientId / clientSecret；robotCode 留空时默认等于 clientId。',
    fields: [
      { key: 'clientId', label: 'Client ID（AppKey）', type: 'text', placeholder: '钉钉应用 AppKey' },
      { key: 'clientSecret', label: 'Client Secret（AppSecret）', type: 'password', secret: true, placeholder: '应用密钥' },
      { key: 'robotCode', label: 'Robot Code', type: 'text', placeholder: '留空默认使用 Client ID' },
      {
        key: 'mode',
        label: '连接模式',
        type: 'select',
        options: [
          ['stream', 'Stream 长连接'],
          ['webhook', 'Webhook'],
        ],
      },
    ],
  },
  {
    id: 'wecom',
    name: '企业微信',
    glyph: '企',
    note: 'ws 模式填 botId / secret；webhook 模式填 token / encodingAESKey / corpId / agentId。',
    fields: [
      {
        key: 'mode',
        label: '连接模式',
        type: 'select',
        options: [
          ['ws', '智能机器人 ws'],
          ['webhook', 'Webhook 自建应用'],
        ],
      },
      { key: 'botId', label: 'Bot ID', type: 'text', placeholder: '智能机器人 Bot ID' },
      { key: 'secret', label: 'Secret', type: 'password', secret: true, placeholder: '应用 Secret' },
      { key: 'token', label: 'Token', type: 'password', secret: true, placeholder: '回调 Token' },
      { key: 'encodingAESKey', label: 'EncodingAESKey', type: 'password', secret: true, placeholder: '43 位 Base64 密钥' },
      { key: 'corpId', label: 'Corp ID', type: 'text', placeholder: '企业 Corp ID' },
      { key: 'agentId', label: 'Agent ID', type: 'text', placeholder: '自建应用 Agent ID' },
    ],
  },
  {
    id: 'weixin',
    name: '微信（个人）',
    glyph: '微',
    note: '启用请点右上角「启用」扫码登录；登录成功凭据由 manager 写入。以下字段只保存连接参数。',
    fields: [
      { key: 'credentialsFile', label: '凭据文件', type: 'text', placeholder: '留空使用默认凭据文件' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: '留空使用默认 iLink 地址' },
      { key: 'typing', label: '发送「正在输入」状态', type: 'checkbox' },
    ],
  },
];

const STATE_META = {
  running: { label: '运行中' },
  stopped: { label: '已停止' },
  starting: { label: '启动中' },
  stopping: { label: '停止中' },
  error: { label: '错误' },
};

const BRIDGE_LABELS = {
  absent: '未启动',
  starting: '启动中',
  ready: '就绪',
  restarting: '重启中',
  stopped: '已停止',
};

const HEALTH_LABELS = {
  connected: '已连接',
  connecting: '连接中',
  degraded: '降级',
  disconnected: '未连接',
};

const ACTION_LABELS = { start: '开始', stop: '停止', restart: '重启' };

const state = {
  online: null,
  manager: null,
  workspaces: [],
  selectedId: null,
  pendingSelectId: null,
  config: null,
  configWorkspaceId: null,
  pairings: [],
  pairingSignature: '',
  actionBusy: null,
  addBusy: false,
  pollTimer: null,
  stateSeq: 0,
  configSeq: 0,
  pairingSeq: 0,
  logsSeq: 0,
};

/**
 * Active QR-connect dialog session. A session object is created per dialog
 * open; async begin/poll callbacks capture it and bail out as soon as the
 * dialog is closed (so a late response can never re-open or re-enable).
 */
const connect = {
  session: null,
  /**
   * Module-wide cancel chain. Closing one dialog and immediately reopening it
   * must not let the old cancel land on the new flow, so every begin awaits
   * all cancels still in flight.
   */
  cancelChain: Promise.resolve(),
};

/** @param {string} id @returns {HTMLElement | null} */
function $(id) {
  return document.getElementById(id);
}

/** @param {string} tag @param {string} [className] @param {string} [text] @returns {HTMLElement} */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} message @returns {HTMLElement} */
function emptyNote(message) {
  return el('p', 'empty-note', message);
}

/** @param {string} [message] */
function showFormError(message) {
  const node = $('add-error');
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.hidden = false;
  } else {
    node.textContent = '';
    node.hidden = true;
  }
}

function hideFormError() {
  showFormError('');
}

/** @returns {object | null} */
function selectedWorkspace() {
  if (!state.selectedId) return null;
  return state.workspaces.find((workspace) => workspace.id === state.selectedId) || null;
}

/** @param {string} id @param {string} [suffix] */
function wsPath(id, suffix = '') {
  return `/api/workspaces/${encodeURIComponent(id)}${suffix}`;
}

/** @param {string} channel */
function isConnectChannel(channel) {
  return CONNECT_CHANNEL_IDS.includes(channel);
}

/** @param {string} id @param {string} channel */
function connectPath(id, channel) {
  return wsPath(id, `/channels/${channel}/connect`);
}

/** @param {string} id @param {string} channel */
function connectCancelPath(id, channel) {
  return wsPath(id, `/channels/${channel}/connect/cancel`);
}

/** @param {string} value */
function stateClass(value) {
  return ['running', 'stopped', 'error', 'starting', 'stopping'].includes(value) ? `dot-${value}` : 'dot-unknown';
}

/** JSON round-trip clone; config payloads are always JSON by contract. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * fetch wrapper: JSON in/out, 15s timeout, human-readable Chinese errors.
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('请求超时（manager 无响应）');
    }
    throw new Error('无法连接 manager（网络错误）');
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      (data && data.error && data.error.message)
      || (data && typeof data.message === 'string' && data.message)
      || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 * @param {number} [timeoutMs]
 */
function toast(message, type = 'info', timeoutMs) {
  const region = $('toast-region');
  if (!region) return;
  const node = el('div', `toast toast-${type}`, message);
  node.title = '点击关闭';
  node.addEventListener('click', () => node.remove());
  region.append(node);
  while (region.children.length > 4) {
    region.firstElementChild.remove();
  }
  const ttl = timeoutMs ?? (type === 'error' ? 6000 : 3200);
  window.setTimeout(() => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 200);
  }, ttl);
}

// ---------------------------------------------------------------------------
// Manager / workspace list
// ---------------------------------------------------------------------------

function renderManagerStatus() {
  const dot = $('manager-dot');
  const text = $('manager-text');
  const addr = $('manager-addr');
  if (!dot || !text) return;

  if (state.online === true) {
    dot.className = 'dot dot-online';
    const listen = state.manager && state.manager.listen;
    if (listen && listen.host && listen.port) {
      text.textContent = `manager 在线 · ${listen.host}:${listen.port}`;
      if (addr) addr.textContent = `${listen.host}:${listen.port}`;
    } else {
      text.textContent = 'manager 在线';
    }
  } else if (state.online === false) {
    dot.className = 'dot dot-offline';
    text.textContent = 'manager 离线 · 每 2 秒重试';
  } else {
    dot.className = 'dot dot-unknown';
    text.textContent = '正在连接 manager…';
  }
}

function renderWorkspaceList() {
  const list = $('workspace-list');
  if (!list) return;
  const scrollTop = list.scrollTop;
  list.replaceChildren();

  if (state.workspaces.length === 0) {
    list.append(el('p', 'sidebar-empty', state.online === false ? 'manager 离线，等待重连…' : '暂无工作区'));
  } else {
    for (const workspace of state.workspaces) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'workspace-item';
      item.dataset.id = workspace.id;
      if (workspace.id === state.selectedId) {
        item.classList.add('selected');
        item.setAttribute('aria-current', 'true');
      }

      const dot = el('span', `dot ${stateClass(workspace.state)}`);
      dot.setAttribute('aria-hidden', 'true');

      const body = el('span', 'workspace-item-body');
      const name = el('span', 'workspace-name', workspace.name || workspace.id);
      name.title = workspace.name || workspace.id;
      body.append(name);

      if (workspace.name && workspace.name !== workspace.id) {
        body.append(el('span', 'workspace-id', workspace.id));
      }

      const chips = el('span', 'workspace-chips');
      const channels = (Array.isArray(workspace.channels) ? workspace.channels : []).filter(
        (channel) => channel && channel.enabled,
      );
      if (channels.length === 0) {
        chips.append(el('span', 'workspace-none', '未启用渠道'));
      } else {
        for (const channel of channels) {
          const def = CHANNEL_DEFS.find((entry) => entry.id === channel.id);
          chips.append(el('span', `chip chip-${channel.id}`, def ? def.name : channel.id));
        }
      }
      body.append(chips);

      item.append(dot, body);
      item.addEventListener('click', () => selectWorkspace(workspace.id));
      list.append(item);
    }
  }

  list.scrollTop = scrollTop;
}

function ensureSelection() {
  if (state.selectedId && state.workspaces.some((workspace) => workspace.id === state.selectedId)) {
    return;
  }
  state.selectedId = null;
  if (state.workspaces.length === 0) {
    clearDetail();
    return;
  }
  selectWorkspace(state.workspaces[0].id);
}

function selectWorkspace(id) {
  if (!state.workspaces.some((workspace) => workspace.id === id)) return;
  const changed = state.selectedId !== id;
  state.selectedId = id;
  renderWorkspaceList();
  renderDetailHeader();

  if (!changed && state.configWorkspaceId === id) return;

  // Clear panels before the async loads so a slow response cannot leak the
  // previous workspace's config/logs into the newly selected one.
  state.config = null;
  state.configWorkspaceId = null;
  state.pairings = [];
  state.pairingSignature = '';

  const grid = $('channels-grid');
  if (grid) grid.replaceChildren(emptyNote('正在加载渠道配置…'));
  setConfigStatus('');
  const pairingList = $('pairing-list');
  if (pairingList) pairingList.replaceChildren(emptyNote('正在加载配对请求…'));
  const logsPre = $('logs-pre');
  if (logsPre) logsPre.textContent = '正在加载日志…';
  const logsMeta = $('logs-meta');
  if (logsMeta) logsMeta.textContent = '';

  void loadConfig(id);
  void loadPairing(id);
  void loadLogs(id);
}

function clearDetail() {
  state.selectedId = null;
  state.config = null;
  state.configWorkspaceId = null;
  state.pairings = [];
  state.pairingSignature = '';

  const detail = $('workspace-detail');
  const empty = $('empty-state');
  if (detail) detail.hidden = true;
  if (empty) empty.hidden = false;

  const hasAny = state.workspaces.length > 0;
  const title = $('empty-title');
  const text = $('empty-text');
  if (title) title.textContent = hasAny ? '请选择一个工作区' : '还没有工作区';
  if (text) {
    text.textContent = hasAny
      ? '从左侧列表选择一个工作区，查看状态、渠道配置、配对请求与日志。'
      : '工作区 = 一个 gateway 实例 = 一套渠道账号。创建一个工作区开始。';
  }
  updateActionButtons();
}

// ---------------------------------------------------------------------------
// Detail header
// ---------------------------------------------------------------------------

function renderDetailHeader() {
  const workspace = selectedWorkspace();
  if (!workspace) {
    clearDetail();
    return;
  }

  const empty = $('empty-state');
  const detail = $('workspace-detail');
  if (empty) empty.hidden = true;
  if (detail) detail.hidden = false;

  $('ws-name').textContent = workspace.name || workspace.id;

  const dir = $('ws-dir');
  dir.textContent = workspace.workspaceDir || '—';
  dir.title = workspace.workspaceDir || '';

  const configFile = $('ws-config-file');
  configFile.textContent = workspace.configFile || '—';
  configFile.title = workspace.configFile || '';

  const stateInfo = STATE_META[workspace.state] || { label: workspace.state || '未知' };
  $('ws-state-dot').className = `dot ${stateClass(workspace.state)}`;
  $('ws-state-text').textContent = stateInfo.label;

  $('ws-bridge').textContent = `DSH bridge：${BRIDGE_LABELS[workspace.bridge] || workspace.bridge || '未知'}`;
  $('ws-sessions').textContent = `会话：${Number.isFinite(workspace.sessions) ? workspace.sessions : 0}`;

  const port = workspace.http && typeof workspace.http.port === 'number' ? workspace.http.port : null;
  const portNode = $('ws-port');
  portNode.textContent = port ? `HTTP 端口：${port}` : 'HTTP 端口：—';
  portNode.title = workspace.http && workspace.http.publicBaseUrl ? workspace.http.publicBaseUrl : '';

  $('ws-autostart').textContent = `自动启动：${workspace.autoStart ? '是' : '否'}`;

  const errorBox = $('ws-error');
  if (workspace.error) {
    errorBox.hidden = false;
    errorBox.textContent = `错误：${workspace.error}`;
  } else {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  updateActionButtons();
  updateChannelHealth();
}

function updateActionButtons() {
  const workspace = selectedWorkspace();
  const busy = state.actionBusy;
  const transient = Boolean(workspace && (workspace.state === 'starting' || workspace.state === 'stopping'));
  const locked = Boolean(busy || transient);

  const start = $('btn-start');
  const stop = $('btn-stop');
  const restart = $('btn-restart');
  const remove = $('btn-delete');
  if (!start || !stop || !restart || !remove) return;

  start.disabled = !workspace || locked || workspace.state === 'running';
  stop.disabled = !workspace || locked || workspace.state === 'stopped' || workspace.state === 'error';
  restart.disabled = !workspace || locked;
  remove.disabled = !workspace || locked;

  start.textContent = busy === 'start' ? '开始中…' : '开始';
  stop.textContent = busy === 'stop' ? '停止中…' : '停止';
  restart.textContent = busy === 'restart' ? '重启中…' : '重启';
  remove.textContent = '删除工作区';
}

function updateChannelHealth() {
  const workspace = selectedWorkspace();
  const channels = workspace && Array.isArray(workspace.channels) ? workspace.channels : [];
  const byId = new Map(channels.filter((channel) => channel && channel.id).map((channel) => [channel.id, channel]));

  for (const def of CHANNEL_DEFS) {
    const node = document.querySelector(`[data-health-for="${def.id}"]`);
    if (!node) continue;
    const channel = byId.get(def.id);
    let label = '未启用';
    let kind = 'unknown';
    let detail = '';

    if (channel && channel.enabled) {
      if (workspace.state === 'running') {
        kind = typeof channel.health === 'string' && channel.health !== '' ? channel.health : 'disconnected';
        label = HEALTH_LABELS[kind] || kind;
        detail = typeof channel.detail === 'string' ? channel.detail : '';
      } else if (workspace.state === 'error') {
        kind = 'error';
        label = '工作区错误';
      } else {
        kind = 'off';
        label = '未运行';
      }
      // v1 微信登录仍走 CLI，未连接基本等价于未登录。
      if (def.id === 'weixin' && kind === 'disconnected') label = '未登录';
    }

    node.textContent = label;
    node.className = `health health-${kind}`;
    node.title = detail;
  }
}

// ---------------------------------------------------------------------------
// Channel config cards
// ---------------------------------------------------------------------------

function setConfigStatus(text, kind = '') {
  const node = $('config-status');
  if (!node) return;
  node.textContent = text;
  node.className = kind ? `status-text ${kind}` : 'status-text';
}

/** @param {string} channelId */
function getLoadedChannelConfig(channelId) {
  const channels = state.config && state.config.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return {};
  const config = channels[channelId];
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function buildSwitch(def, channelConfig) {
  const label = document.createElement('label');
  label.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `ch-${def.id}-enabled`;
  input.dataset.field = 'enabled';
  input.checked = channelConfig.enabled === true;
  const track = el('span', 'switch-track');
  const text = el('span', 'switch-text', '启用');
  label.append(input, track, text);
  return label;
}

/**
 * feishu / weixin are enabled only by the connect dialog (contract §10.6), so
 * their card never flips `enabled` locally. The control reflects the last
 * loaded config/state; after a successful connect the whole page is refreshed.
 */
function buildConnectControl(def, channelConfig) {
  const wrap = el('div', 'channel-connect');
  if (channelConfig.enabled === true) {
    wrap.append(el('span', 'health health-connected', '已启用'));
    const disable = el('button', 'btn btn-sm', '停用');
    disable.type = 'button';
    disable.addEventListener('click', () => {
      void disableConnectChannel(def);
    });
    wrap.append(disable);
    return wrap;
  }

  const enable = el('button', 'btn btn-primary btn-sm', '启用');
  enable.type = 'button';
  enable.dataset.connect = def.id;
  enable.addEventListener('click', () => openConnectDialog(def.id));
  wrap.append(enable);
  return wrap;
}

/**
 * Disable a QR-connect channel. Reconnecting an enabled channel requires this
 * first: `begin` returns 409 while the channel is enabled (contract §10.3).
 * @param {{ id: string, name: string }} def
 */
async function disableConnectChannel(def) {
  const workspace = selectedWorkspace();
  if (!workspace) return;
  if (!state.config || state.configWorkspaceId !== workspace.id) {
    toast('配置尚未加载完成，请稍后再试', 'error');
    return;
  }

  const nextConfig = cloneJson(state.config);
  if (!nextConfig.channels || typeof nextConfig.channels !== 'object' || Array.isArray(nextConfig.channels)) {
    nextConfig.channels = {};
  }
  const previousChannel =
    nextConfig.channels[def.id] && typeof nextConfig.channels[def.id] === 'object' ? nextConfig.channels[def.id] : {};
  nextConfig.channels[def.id] = { ...previousChannel, enabled: false };

  try {
    await api(wsPath(workspace.id, '/config'), { method: 'PUT', body: nextConfig });
    toast(`${def.name}已停用`, 'success');
    if (state.selectedId === workspace.id) {
      await loadConfig(workspace.id);
      await refreshState();
    }
  } catch (error) {
    toast(`${def.name}停用失败：${error.message}`, 'error');
  }
}

function buildField(def, field, channelConfig) {
  const wrap = document.createElement('div');
  const id = `ch-${def.id}-${field.key}`;
  const value = channelConfig[field.key];

  if (field.type === 'checkbox') {
    wrap.className = 'field field-checkbox';
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.dataset.field = field.key;
    input.checked = value !== false;
    const text = el('span', undefined, field.label);
    label.append(input, text);
    wrap.append(label);
    return wrap;
  }

  wrap.className = 'field';
  const label = el('label', undefined, field.label);
  label.htmlFor = id;
  wrap.append(label);

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    const options = field.options.slice();
    const current = value === undefined || value === null ? '' : String(value);
    if (current !== '' && !options.some(([optionValue]) => optionValue === current)) {
      options.unshift([current, `${current}（当前值）`]);
    }
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      input.append(option);
    }
    input.value = current !== '' ? current : options[0][0];
  } else {
    input = document.createElement('input');
    input.type = field.type;
    input.spellcheck = false;
    if (field.type === 'password') {
      input.autocomplete = 'new-password';
    } else {
      input.autocomplete = 'off';
    }

    if (field.secret) {
      if (value === '***') {
        input.value = '';
        input.placeholder = '已保存，留空不改';
        input.dataset.masked = '1';
      } else {
        input.value = typeof value === 'string' ? value : '';
        input.placeholder = field.placeholder || '未设置';
      }
    } else {
      input.value = value === undefined || value === null ? '' : String(value);
      if (field.placeholder) input.placeholder = field.placeholder;
    }
  }

  input.id = id;
  input.dataset.field = field.key;
  wrap.append(input);
  return wrap;
}

function buildChannelCard(def) {
  const channelConfig = getLoadedChannelConfig(def.id);
  const card = document.createElement('article');
  card.className = 'channel-card';
  card.dataset.channel = def.id;

  const head = el('header', 'channel-head');
  const title = el('div', 'channel-title');
  const glyph = el('span', `channel-glyph channel-glyph-${def.id}`, def.glyph);
  glyph.setAttribute('aria-hidden', 'true');
  const heading = el('h3', undefined, def.name);
  const health = el('span', 'health health-unknown', '未加载');
  health.dataset.healthFor = def.id;
  title.append(glyph, heading, health);
  const enabledControl = isConnectChannel(def.id)
    ? buildConnectControl(def, channelConfig)
    : buildSwitch(def, channelConfig);
  head.append(title, enabledControl);
  card.append(head);

  const fields = el('div', 'channel-fields');
  for (const field of def.fields) {
    fields.append(buildField(def, field, channelConfig));
  }
  card.append(fields);

  const foot = el('footer', 'channel-foot');
  foot.append(el('p', 'channel-note', def.note));
  const save = el('button', 'btn btn-primary btn-sm', '保存');
  save.type = 'button';
  save.addEventListener('click', () => {
    void saveChannel(def, card, save);
  });
  foot.append(save);
  card.append(foot);

  card.addEventListener('input', () => card.classList.add('is-dirty'));
  card.addEventListener('change', () => card.classList.add('is-dirty'));

  return card;
}

function renderChannels() {
  const grid = $('channels-grid');
  if (!grid) return;
  grid.replaceChildren();
  if (!state.config) {
    grid.append(emptyNote('渠道配置尚未加载。'));
    return;
  }
  for (const def of CHANNEL_DEFS) {
    grid.append(buildChannelCard(def));
  }
  updateChannelHealth();
}

function renderChannelsError(message) {
  const grid = $('channels-grid');
  if (!grid) return;
  grid.replaceChildren();

  const wrap = el('div', 'config-error');
  wrap.append(emptyNote(`无法加载配置：${message}`));
  const retry = el('button', 'btn btn-sm', '重试');
  retry.type = 'button';
  retry.addEventListener('click', () => {
    if (state.selectedId) void loadConfig(state.selectedId);
  });
  wrap.append(retry);
  grid.append(wrap);
}

/**
 * Merge the card's values into the loaded config.
 * Secret fields left empty keep the loaded value (`***` / env reference); the
 * manager resolves `***` back to the real secret per contract §4.
 * @param {{ id: string, fields: Array<object> }} def
 * @param {HTMLElement} card
 */
function readChannelForm(def, card) {
  const loaded = getLoadedChannelConfig(def.id);
  const patch = {};
  const enabled = card.querySelector('input[data-field="enabled"]');
  // QR-connect channels have no local switch: keep the loaded value instead of
  // silently disabling the channel when an unrelated field is saved.
  patch.enabled = enabled ? Boolean(enabled.checked) : loaded.enabled === true;

  for (const field of def.fields) {
    const input = card.querySelector(`input[data-field="${field.key}"], select[data-field="${field.key}"]`);
    if (!input) continue;

    if (field.type === 'checkbox') {
      patch[field.key] = Boolean(input.checked);
      continue;
    }

    const raw = input.value;
    if (field.type === 'select') {
      if (raw !== '') patch[field.key] = raw;
      continue;
    }

    if (field.secret) {
      if (raw.trim() !== '') patch[field.key] = raw;
      else patch[field.key] = Object.prototype.hasOwnProperty.call(loaded, field.key) ? loaded[field.key] : '';
    } else {
      patch[field.key] = raw.trim();
    }
  }

  return patch;
}

async function saveChannel(def, card, button) {
  const workspace = selectedWorkspace();
  if (!workspace) return;
  if (!state.config || state.configWorkspaceId !== workspace.id) {
    toast('配置尚未加载完成，请稍后再试', 'error');
    return;
  }
  if (button.disabled) return;

  const patch = readChannelForm(def, card);
  const nextConfig = cloneJson(state.config);
  if (!nextConfig.channels || typeof nextConfig.channels !== 'object' || Array.isArray(nextConfig.channels)) {
    nextConfig.channels = {};
  }
  const previousChannel =
    nextConfig.channels[def.id] && typeof nextConfig.channels[def.id] === 'object' ? nextConfig.channels[def.id] : {};
  nextConfig.channels[def.id] = { ...previousChannel, ...patch };

  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = '保存中…';

  try {
    await api(wsPath(workspace.id, '/config'), { method: 'PUT', body: nextConfig });
    toast(`${def.name}配置已保存${workspace.state === 'running' ? '，工作区将自动重启' : ''}`, 'success');
    if (state.selectedId === workspace.id) {
      await loadConfig(workspace.id);
      await refreshState();
    }
  } catch (error) {
    toast(`${def.name}配置保存失败：${error.message}`, 'error');
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
      card.classList.add('is-dirty');
    }
  }
}

async function loadConfig(id) {
  const seq = ++state.configSeq;
  setConfigStatus('加载中…');
  try {
    const data = await api(wsPath(id, '/config'));
    if (seq !== state.configSeq || state.selectedId !== id) return;
    const config = normalizeConfigPayload(data);
    if (!config) throw new Error('配置响应格式不正确');
    state.config = config;
    state.configWorkspaceId = id;
    renderChannels();
    setConfigStatus('配置已加载', 'ok');
    updateChannelHealth();
  } catch (error) {
    if (seq !== state.configSeq || state.selectedId !== id) return;
    state.config = null;
    state.configWorkspaceId = null;
    setConfigStatus('配置加载失败', 'error');
    renderChannelsError(error.message);
    toast(`加载渠道配置失败：${error.message}`, 'error');
  }
}

function normalizeConfigPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) return data.config;
  return data;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function normalizePairings(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.pairings)) return data.pairings;
  if (Array.isArray(data.pendingPairings)) return data.pendingPairings;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function renderPairing() {
  const list = $('pairing-list');
  if (!list) return;
  list.replaceChildren();

  if (state.pairings.length === 0) {
    list.append(emptyNote('暂无待配对请求。新用户私聊机器人后会在这里出现配对码。'));
    return;
  }

  for (const pairing of state.pairings) {
    if (!pairing || typeof pairing !== 'object') continue;
    const item = el('div', 'pairing-item');
    const code = el('code', 'pairing-code', pairing.code === undefined ? '—' : String(pairing.code));

    const main = el('div', 'pairing-main');
    const sender = pairing.senderId === undefined ? '未知' : String(pairing.senderId);
    const name = pairing.name ? `（${pairing.name}）` : '';
    main.append(el('p', 'pairing-meta', `渠道 ${channelName(pairing.channel)} · 发送者 ${sender}${name}`));

    const expiresAt = Number(pairing.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      const date = new Date(expiresAt);
      if (!Number.isNaN(date.getTime())) {
        main.append(el('p', 'pairing-expire', `有效期至 ${date.toLocaleTimeString('zh-CN', { hour12: false })}`));
      }
    }

    const approve = el('button', 'btn btn-primary btn-sm', '批准');
    approve.type = 'button';
    if (pairing.code === undefined || pairing.code === null) {
      approve.disabled = true;
    } else {
      const codeValue = pairing.code;
      approve.addEventListener('click', () => {
        void approvePairing(codeValue, approve);
      });
    }

    item.append(code, main, approve);
    list.append(item);
  }
}

function channelName(id) {
  const def = CHANNEL_DEFS.find((entry) => entry.id === id);
  return def ? def.name : id === undefined || id === null || id === '' ? '未知' : String(id);
}

function syncPairingsFromState() {
  const workspace = selectedWorkspace();
  if (!workspace || !Array.isArray(workspace.pendingPairings)) return;
  const signature = JSON.stringify(workspace.pendingPairings);
  if (signature === state.pairingSignature) return;
  state.pairingSignature = signature;
  state.pairings = workspace.pendingPairings;
  renderPairing();
}

async function loadPairing(id) {
  const seq = ++state.pairingSeq;
  try {
    const data = await api(wsPath(id, '/pairing'));
    if (seq !== state.pairingSeq || state.selectedId !== id) return;
    state.pairings = normalizePairings(data);
    state.pairingSignature = JSON.stringify(state.pairings);
    renderPairing();
  } catch (error) {
    if (seq !== state.pairingSeq || state.selectedId !== id) return;
    const list = $('pairing-list');
    if (list) list.replaceChildren(emptyNote(`配对请求加载失败：${error.message}`));
    toast(`加载配对请求失败：${error.message}`, 'error');
  }
}

async function approvePairing(code, button) {
  const id = state.selectedId;
  if (!id || code === undefined || code === null) return;
  if (button.disabled) return;

  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = '批准中…';

  try {
    await api(wsPath(id, '/pairing/approve'), { method: 'POST', body: { code: String(code) } });
    toast(`已批准配对码 ${code}`, 'success');
    if (state.selectedId === id) {
      await loadPairing(id);
      await refreshState();
    }
  } catch (error) {
    toast(`批准配对失败：${error.message}`, 'error');
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function normalizeLogs(data) {
  if (Array.isArray(data)) return data.map((line) => String(line));
  if (typeof data === 'string') return data.split('\n');
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.lines)) return data.lines.map((line) => String(line));
  if (Array.isArray(data.logs)) return data.logs.map((line) => String(line));
  return [];
}

async function loadLogs(id) {
  const seq = ++state.logsSeq;
  const meta = $('logs-meta');
  if (meta) meta.textContent = '加载中…';

  try {
    const data = await api(wsPath(id, `/logs?lines=${LOG_LINES}`));
    if (seq !== state.logsSeq || state.selectedId !== id) return;
    const lines = normalizeLogs(data);
    const pre = $('logs-pre');
    if (!pre) return;
    pre.textContent = lines.length > 0 ? lines.join('\n') : '（暂无日志）';
    pre.scrollTop = pre.scrollHeight;
    if (meta) {
      meta.textContent = `${lines.length} 行 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    }
  } catch (error) {
    if (seq !== state.logsSeq || state.selectedId !== id) return;
    const pre = $('logs-pre');
    if (pre) pre.textContent = `日志加载失败：${error.message}`;
    if (meta) meta.textContent = '';
    toast(`加载日志失败：${error.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function runAction(action) {
  const workspace = selectedWorkspace();
  if (!workspace || state.actionBusy) return;

  state.actionBusy = action;
  updateActionButtons();
  try {
    await api(wsPath(workspace.id, `/${action}`), { method: 'POST' });
    toast(`${ACTION_LABELS[action] || action}指令已发送：${workspace.name || workspace.id}`, 'success');
  } catch (error) {
    toast(`${ACTION_LABELS[action] || action}失败：${error.message}`, 'error');
  } finally {
    state.actionBusy = null;
    if (state.selectedId === workspace.id) updateActionButtons();
    void refreshState();
  }
}

async function deleteWorkspace() {
  const workspace = selectedWorkspace();
  if (!workspace || state.actionBusy) return;

  const confirmed = window.confirm(
    `确定删除工作区「${workspace.name || workspace.id}」吗？\n\n`
      + '将先停止工作区并从 manager.json 移除；磁盘上的配置文件不会被删除。',
  );
  if (!confirmed) return;

  state.actionBusy = 'delete';
  updateActionButtons();
  try {
    await api(wsPath(workspace.id), { method: 'DELETE' });
    toast(`已删除工作区：${workspace.name || workspace.id}`, 'success');
    if (state.selectedId === workspace.id) {
      clearDetail();
    }
    await refreshState();
  } catch (error) {
    toast(`删除失败：${error.message}`, 'error');
  } finally {
    state.actionBusy = null;
    updateActionButtons();
  }
}

// ---------------------------------------------------------------------------
// Add workspace dialog
// ---------------------------------------------------------------------------

function openAddDialog() {
  const dialog = $('add-dialog');
  if (!dialog) return;
  if (dialog.open) {
    $('add-name').focus();
    return;
  }
  $('add-form').reset();
  hideFormError();
  state.addBusy = false;
  $('add-submit').disabled = false;
  $('add-submit').textContent = '创建';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  window.setTimeout(() => $('add-name').focus(), 0);
}

async function onAddSubmit(event) {
  event.preventDefault();
  if (state.addBusy) return;

  hideFormError();
  const name = $('add-name').value.trim();
  const workspaceDir = $('add-dir').value.trim();
  if (!name) {
    showFormError('请填写工作区名称');
    $('add-name').focus();
    return;
  }
  if (!workspaceDir) {
    showFormError('请填写工作区目录');
    $('add-dir').focus();
    return;
  }

  const channels = Array.from($('add-form').querySelectorAll('input[name="channels"]:checked')).map(
    (input) => input.value,
  );
  const submit = $('add-submit');
  state.addBusy = true;
  submit.disabled = true;
  submit.textContent = '创建中…';

  try {
    const created = await api('/api/workspaces', { method: 'POST', body: { name, workspaceDir, channels } });
    const createdId = extractCreatedId(created);
    if (createdId) state.pendingSelectId = createdId;

    state.addBusy = false;
    submit.disabled = false;
    submit.textContent = '创建';
    $('add-dialog').close();
    toast(`工作区「${name}」已创建`, 'success');

    await refreshState();
    if (!createdId) {
      const match = state.workspaces.find(
        (workspace) => workspace.name === name && workspace.workspaceDir === workspaceDir,
      );
      if (match) selectWorkspace(match.id);
    }
  } catch (error) {
    toast(`创建工作区失败：${error.message}`, 'error');
    showFormError(error.message);
  } finally {
    state.addBusy = false;
    submit.disabled = false;
    submit.textContent = '创建';
  }
}

function extractCreatedId(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.id === 'string' && data.id !== '') return data.id;
  if (data.workspace && typeof data.workspace === 'object' && typeof data.workspace.id === 'string') {
    return data.workspace.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel QR connect dialog (contract §10)
//
// Rule: closing the dialog before `confirmed` cancels the flow and leaves the
// channel disabled. Nothing here ever writes `enabled:true` optimistically;
// the switch/health render only from the refreshed state/config.
// ---------------------------------------------------------------------------

function createConnectSession(workspaceId, channel) {
  return {
    workspaceId,
    channel,
    mode: 'qr',
    flow: null,
    flowBegun: false,
    everFlowBegun: false,
    beginBusy: false,
    confirmed: false,
    closed: false,
    pollBusy: false,
    pollTimer: null,
    pollFailures: 0,
    manualConfig: null,
    manualLoaded: false,
    manualBusy: false,
  };
}

/** @param {string} channelId */
function openConnectDialog(channelId) {
  const workspace = selectedWorkspace();
  const def = CHANNEL_DEFS.find((entry) => entry.id === channelId);
  const dialog = $('connect-dialog');
  if (!workspace || !def || !dialog || !isConnectChannel(channelId)) return;
  if (connect.session && !connect.session.closed) return;

  const session = createConnectSession(workspace.id, channelId);
  connect.session = session;

  $('connect-title').textContent = `连接${def.name}`;
  $('connect-subtitle').textContent = channelId === 'feishu'
    ? '扫码创建/登录飞书应用，或切到「手动填写」直接填写应用凭据。'
    : '用微信扫描二维码，并在手机上确认登录。扫码成功前关闭弹窗不会启用渠道。';
  $('connect-tabs').hidden = channelId !== 'feishu';
  $('connect-hint').textContent = channelId === 'feishu'
    ? '用飞书 App 扫描二维码，并在手机上确认。'
    : '用微信扫描二维码，并在手机上确认登录。';

  const qrTab = $('connect-tab-qr');
  const manualTab = $('connect-tab-manual');
  if (qrTab) {
    qrTab.classList.add('is-active');
    qrTab.setAttribute('aria-selected', 'true');
  }
  if (manualTab) {
    manualTab.classList.remove('is-active');
    manualTab.setAttribute('aria-selected', 'false');
  }
  $('connect-qr-panel').hidden = false;
  $('connect-manual-panel').hidden = true;
  hideManualError();
  hideRegenerate();
  setConnectDetail('');
  clearQrImage();
  setQrPlaceholder('正在生成二维码…');
  setConnectStatus('正在生成二维码…', 'pending');

  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }

  void beginConnect();
}

/**
 * Close the dialog. When the flow has not reached `confirmed`, POST cancel so
 * the manager guarantees `enabled:false` (contract §10.6). A confirmed flow is
 * closed without cancel.
 * @param {{ userInitiated?: boolean }} [options]
 */
function closeConnectDialog(options = {}) {
  const { userInitiated = false } = options;
  const session = connect.session;
  if (!session || session.closed) return;

  const wasConfirmed = session.confirmed;
  session.closed = true;
  stopConnectPoll(session);
  connect.session = null;

  const dialog = $('connect-dialog');
  if (dialog) {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  if (!wasConfirmed && (session.flowBegun || session.beginBusy || session.everFlowBegun)) {
    void queueCancelFlow(session);
  }
  if (userInitiated && !wasConfirmed) {
    toast('已取消，渠道未启用', 'info');
  }
}

/**
 * Serialize cancel requests for one session: a later begin must wait for an
 * earlier cancel, otherwise the cancel could land on the new flow.
 * @param {object} session
 */
function queueCancelFlow(session) {
  if (!session) return Promise.resolve();
  const previous = Promise.all([session.cancelPromise || Promise.resolve(), connect.cancelChain]);
  const next = previous.then(() => cancelConnectFlow(session.workspaceId, session.channel));
  session.cancelPromise = next;
  connect.cancelChain = next;
  return next;
}

/** @param {string} workspaceId @param {string} channel */
async function cancelConnectFlow(workspaceId, channel) {
  try {
    await api(connectCancelPath(workspaceId, channel), { method: 'POST' });
  } catch (error) {
    toast(`取消连接失败：${error.message}`, 'error');
  }
}

function beginConnect() {
  const session = connect.session;
  if (!session) return Promise.resolve();
  // Keep the handle of an already-running begin: the manual tab waits on it
  // before cancelling the QR flow.
  if (session.beginBusy && session.beginPromise) return session.beginPromise;
  const promise = runConnectBegin(session);
  session.beginPromise = promise;
  return promise;
}

/** @param {object} session */
async function runConnectBegin(session) {
  if (!session || session.closed || session.mode !== 'qr' || session.beginBusy) return;

  session.beginBusy = true;
  session.flow = null;
  session.flowBegun = false;
  session.pollFailures = 0;
  stopConnectPoll(session);
  hideRegenerate();
  clearQrImage();
  setQrPlaceholder('正在生成二维码…');
  setConnectStatus('正在生成二维码…', 'pending');
  setConnectDetail('');

  // A mode switch or a previous dialog may still be cancelling the old flow;
  // never begin a new one until those cancels have landed (otherwise a cancel
  // could eat the new flow).
  try {
    await connect.cancelChain;
  } catch {
    // cancellation errors are surfaced by cancelConnectFlow itself
  }
  if (session.closed || session !== connect.session || session.mode !== 'qr') {
    session.beginBusy = false;
    return;
  }

  try {
    const flow = await api(connectPath(session.workspaceId, session.channel), { method: 'POST', body: { mode: 'qr' } });
    session.beginBusy = false;
    if (session.closed || session !== connect.session) {
      // The dialog was closed while begin was in flight: never leave a flow
      // running behind the user's back.
      void queueCancelFlow(session);
      return;
    }
    if (session.mode !== 'qr') {
      if (!session.confirmed) void queueCancelFlow(session);
      return;
    }
    if (!isConnectFlow(flow)) throw new Error('manager 返回的连接状态格式不正确');
    session.flowBegun = true;
    session.everFlowBegun = true;
    applyConnectFlow(session, flow);
  } catch (error) {
    session.beginBusy = false;
    if (session.closed || session !== connect.session) {
      // A 409 means the channel was already enabled by someone else: cancelling
      // here would disable it, so leave it alone.
      if (!error || error.status !== 409) void queueCancelFlow(session);
      return;
    }
    if (session.mode !== 'qr') return;
    renderConnectFailure(session, error.message);
    toast(`生成二维码失败：${error.message}`, 'error');
  }
}

/** @param {unknown} flow */
function isConnectFlow(flow) {
  return Boolean(flow && typeof flow === 'object' && !Array.isArray(flow) && typeof flow.state === 'string');
}

/** @param {object} session @param {object} flow */
function applyConnectFlow(session, flow) {
  if (!session || session.closed || session !== connect.session) return;
  session.flow = flow;
  session.pollFailures = 0;

  const meta = CONNECT_STATE_META[flow.state] || { label: String(flow.state), kind: 'pending' };
  setConnectStatus(meta.label, meta.kind);

  let detail = '';
  if (typeof flow.error === 'string' && flow.error !== '') detail = flow.error;
  else if (typeof flow.detail === 'string' && flow.detail !== '') detail = flow.detail;
  setConnectDetail(detail);

  const qr = flow.qr && typeof flow.qr === 'object' ? flow.qr : null;
  const dataUrl = qr && typeof qr.dataUrl === 'string' ? qr.dataUrl : '';
  if (dataUrl.startsWith('data:image/')) {
    setQrImage(dataUrl);
  } else if (flow.state === 'pending' || flow.state === 'scanned') {
    setQrPlaceholder('等待二维码…');
  }

  if (flow.state === 'confirmed') {
    void onConnectConfirmed(session);
    return;
  }

  if (flow.state === 'expired' || flow.state === 'failed' || flow.state === 'cancelled') {
    stopConnectPoll(session);
    showRegenerate();
    clearQrImage();
    if (flow.state === 'expired') setQrPlaceholder('二维码已过期，请重新生成');
    else if (flow.state === 'failed') setQrPlaceholder('连接失败，请重新生成二维码');
    else setQrPlaceholder('连接已取消，可重新生成二维码');
    return;
  }

  hideRegenerate();
  scheduleConnectPoll(session, flow.intervalMs);
}

/** @param {object} session @param {number|undefined} intervalMs */
function scheduleConnectPoll(session, intervalMs) {
  if (!session || session.closed || session !== connect.session || session.confirmed) return;
  stopConnectPoll(session);
  const raw = Number(intervalMs);
  const delay = Number.isFinite(raw) && raw >= 0 ? Math.min(Math.max(raw, CONNECT_MIN_INTERVAL_MS), CONNECT_MAX_INTERVAL_MS) : CONNECT_DEFAULT_INTERVAL_MS;
  session.pollTimer = window.setTimeout(() => {
    session.pollTimer = null;
    void pollConnect(session);
  }, delay);
}

/** @param {object} session */
async function pollConnect(session) {
  if (!session || session.closed || session !== connect.session || session.confirmed || session.pollBusy) return;
  session.pollBusy = true;
  try {
    const flow = await api(connectPath(session.workspaceId, session.channel));
    session.pollBusy = false;
    if (session.closed || session !== connect.session) return;
    if (!isConnectFlow(flow)) {
      scheduleConnectPoll(session, CONNECT_DEFAULT_INTERVAL_MS);
      return;
    }
    applyConnectFlow(session, flow);
  } catch (error) {
    session.pollBusy = false;
    if (session.closed || session !== connect.session) return;
    session.pollFailures += 1;
    if (session.pollFailures >= 5) {
      renderConnectFailure(session, `无法查询连接状态：${error.message}`);
      return;
    }
    setConnectDetail(`查询状态失败，正在重试…（${error.message}）`);
    scheduleConnectPoll(session, CONNECT_DEFAULT_INTERVAL_MS);
  }
}

function stopConnectPoll(session) {
  if (!session) return;
  if (session.pollTimer) {
    window.clearTimeout(session.pollTimer);
    session.pollTimer = null;
  }
  session.pollBusy = false;
}

/** @param {object} session */
async function onConnectConfirmed(session) {
  if (!session || session.closed || session !== connect.session || session.confirmed) return;
  session.confirmed = true;
  stopConnectPoll(session);
  hideRegenerate();
  setConnectStatus('已确认，渠道已启用', 'success');
  setConnectDetail('');

  const def = CHANNEL_DEFS.find((entry) => entry.id === session.channel);
  toast(`${def ? def.name : session.channel}扫码连接成功，渠道已启用`, 'success');

  await refreshState();
  if (state.selectedId === session.workspaceId) {
    await loadConfig(session.workspaceId);
  }
  if (session !== connect.session || session.closed) return;
  closeConnectDialog();
}

/** @param {object} session @param {string} message */
function renderConnectFailure(session, message) {
  if (!session || session.closed || session !== connect.session) return;
  stopConnectPoll(session);
  setConnectStatus('连接失败', 'error');
  setConnectDetail(message);
  showRegenerate();
}

function setConnectStatus(text, kind = '') {
  const node = $('connect-status');
  if (!node) return;
  node.textContent = text;
  node.className = kind ? `connect-status connect-status-${kind}` : 'connect-status';
}

function setConnectDetail(text) {
  const node = $('connect-detail');
  if (!node) return;
  if (text) {
    node.textContent = text;
    node.hidden = false;
  } else {
    node.textContent = '';
    node.hidden = true;
  }
}

function showRegenerate() {
  const node = $('connect-regenerate');
  if (node) node.hidden = false;
}

function hideRegenerate() {
  const node = $('connect-regenerate');
  if (node) node.hidden = true;
}

function setQrPlaceholder(text) {
  const node = $('qr-placeholder');
  if (!node) return;
  node.textContent = text;
  node.hidden = text === '';
}

/** Render a server-generated PNG data URL as an <img> (never an external URL). */
function setQrImage(dataUrl) {
  const slot = $('qr-image-slot');
  if (!slot) return;
  let img = slot.querySelector('img[data-qr]');
  if (!img) {
    img = document.createElement('img');
    img.className = 'qr-image';
    img.alt = '登录二维码';
    img.dataset.qr = '1';
    img.width = 240;
    img.height = 240;
    slot.replaceChildren(img);
  }
  if (img.getAttribute('src') !== dataUrl) img.src = dataUrl;
  setQrPlaceholder('');
}

function clearQrImage() {
  const slot = $('qr-image-slot');
  if (slot) slot.replaceChildren();
}

/**
 * Switch between the QR panel and the manual Feishu form. The two modes are
 * mutually exclusive; switching to manual abandons (cancels) the QR flow.
 * @param {'qr'|'manual'} mode
 * @param {{ start?: boolean }} [options]
 */
function setConnectMode(mode, options = {}) {
  const session = connect.session;
  if (!session || session.closed) return;
  if (mode !== 'qr' && mode !== 'manual') return;
  if (mode === 'manual' && session.channel !== 'feishu') return;

  const changed = session.mode !== mode;
  session.mode = mode;

  const qrTab = $('connect-tab-qr');
  const manualTab = $('connect-tab-manual');
  if (qrTab) {
    qrTab.classList.toggle('is-active', mode === 'qr');
    qrTab.setAttribute('aria-selected', mode === 'qr' ? 'true' : 'false');
  }
  if (manualTab) {
    manualTab.classList.toggle('is-active', mode === 'manual');
    manualTab.setAttribute('aria-selected', mode === 'manual' ? 'true' : 'false');
  }
  $('connect-qr-panel').hidden = mode !== 'qr';
  $('connect-manual-panel').hidden = mode !== 'manual';

  if (mode === 'manual') {
    if (changed || options.start) void enterManualMode(session);
  } else if (changed || options.start) {
    void beginConnect();
  }
}

/**
 * Abandon the QR flow before showing the manual form. Waits for any in-flight
 * begin and for the cancel to land, so saving manual config cannot race with a
 * cancel that would disable the channel right afterwards.
 * @param {object} session
 */
async function enterManualMode(session) {
  if (!session || session.closed || session !== connect.session) return;
  stopConnectPoll(session);

  // Lock the form immediately: there is an await (begin/cancel) before the
  // config arrives, and saving a half-loaded form must not be possible.
  session.manualLoaded = false;
  const submit = $('connect-manual-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = '加载中…';
  }

  if (session.beginPromise) {
    try {
      await session.beginPromise;
    } catch {
      // beginConnect handles its own errors
    }
  }
  if (!session || session.closed || session !== connect.session || session.mode !== 'manual') return;
  await leaveQrFlow(session);
  if (!session || session.closed || session !== connect.session || session.mode !== 'manual') return;
  await loadManualConfig(session);
}

/** @param {object} session */
async function leaveQrFlow(session) {
  if (!session || session.closed || session !== connect.session) return;
  stopConnectPoll(session);
  if (session.everFlowBegun && !session.confirmed) {
    session.flowBegun = false;
    await queueCancelFlow(session);
  }
}

/** GET the current config and prefill the manual Feishu form. @param {object} session */
async function loadManualConfig(session) {
  if (!session || session.closed || session !== connect.session) return;
  hideManualError();
  const submit = $('connect-manual-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = '加载中…';
  }
  session.manualLoaded = false;

  try {
    const data = await api(wsPath(session.workspaceId, '/config'));
    if (session.closed || session !== connect.session) return;
    const config = normalizeConfigPayload(data);
    if (!config) throw new Error('配置响应格式不正确');
    session.manualConfig = config;
    const current = getChannelConfigFrom(config, 'feishu');

    const appIdInput = $('connect-app-id');
    const secretInput = $('connect-app-secret');
    const domainInput = $('connect-domain');
    if (appIdInput) appIdInput.value = typeof current.appId === 'string' ? current.appId : '';
    if (domainInput) domainInput.value = current.domain === 'lark' ? 'lark' : 'feishu';
    if (secretInput) {
      if (current.appSecret === '***') {
        secretInput.value = '';
        secretInput.placeholder = '已保存，留空不改';
      } else {
        secretInput.value = typeof current.appSecret === 'string' ? current.appSecret : '';
        secretInput.placeholder = '应用密钥';
      }
    }

    session.manualLoaded = true;
    if (submit) {
      submit.disabled = false;
      submit.textContent = '保存并启用';
    }
  } catch (error) {
    if (session.closed || session !== connect.session) return;
    session.manualLoaded = false;
    showManualError(`读取当前配置失败：${error.message}`);
    if (submit) {
      submit.disabled = false;
      submit.textContent = '重试加载';
    }
    toast(`读取飞书配置失败：${error.message}`, 'error');
  }
}

/** @param {object} config @param {string} channelId */
function getChannelConfigFrom(config, channelId) {
  const channels = config && config.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return {};
  const channelConfig = channels[channelId];
  return channelConfig && typeof channelConfig === 'object' && !Array.isArray(channelConfig) ? channelConfig : {};
}

/** @param {object} session */
async function saveManualConnect(session) {
  if (!session || session.closed || session !== connect.session || session.manualBusy) return;

  if (!session.manualLoaded) {
    void loadManualConfig(session);
    return;
  }

  const appIdInput = $('connect-app-id');
  const secretInput = $('connect-app-secret');
  const domainInput = $('connect-domain');
  const submit = $('connect-manual-submit');

  const appId = appIdInput ? appIdInput.value.trim() : '';
  const secret = secretInput ? secretInput.value.trim() : '';
  const domain = domainInput && domainInput.value === 'lark' ? 'lark' : 'feishu';

  if (appId === '') {
    showManualError('请填写 App ID');
    if (appIdInput) appIdInput.focus();
    return;
  }

  const previous = getChannelConfigFrom(session.manualConfig || {}, 'feishu');
  const patch = { ...previous, enabled: true, appId, domain };
  if (secret !== '') patch.appSecret = secret;
  else if (typeof previous.appSecret !== 'string' || previous.appSecret === '') {
    showManualError('请填写 App Secret');
    if (secretInput) secretInput.focus();
    return;
  }

  const nextConfig = cloneJson(session.manualConfig || {});
  if (!nextConfig.channels || typeof nextConfig.channels !== 'object' || Array.isArray(nextConfig.channels)) {
    nextConfig.channels = {};
  }
  nextConfig.channels.feishu = { ...previous, ...patch };

  hideManualError();
  session.manualBusy = true;
  if (submit) {
    submit.disabled = true;
    submit.textContent = '保存中…';
  }

  // Let any pending QR-flow cancel finish first; otherwise it could land after
  // this PUT and disable the channel we just enabled.
  try {
    await connect.cancelChain;
  } catch {
    // cancellation errors are surfaced by cancelConnectFlow itself
  }
  if (session.closed || session !== connect.session) return;

  try {
    await api(wsPath(session.workspaceId, '/config'), { method: 'PUT', body: nextConfig });
    session.manualBusy = false;
    if (session.closed || session !== connect.session) return;
    // Manual save is equivalent to enabling (contract §10.5).
    session.confirmed = true;
    toast('飞书配置已保存，渠道已启用', 'success');
    await refreshState();
    if (state.selectedId === session.workspaceId) {
      await loadConfig(session.workspaceId);
    }
    if (session !== connect.session || session.closed) return;
    closeConnectDialog();
  } catch (error) {
    session.manualBusy = false;
    if (session.closed || session !== connect.session) return;
    showManualError(`保存失败：${error.message}`);
    toast(`飞书配置保存失败：${error.message}`, 'error');
    if (submit) {
      submit.disabled = false;
      submit.textContent = '保存并启用';
    }
  }
}

function showManualError(message) {
  const node = $('connect-manual-error');
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.hidden = false;
  } else {
    node.textContent = '';
    node.hidden = true;
  }
}

function hideManualError() {
  showManualError('');
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

function applyState(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.workspaces)) {
    throw new Error('manager 返回的状态格式不正确');
  }

  state.manager = data.manager && typeof data.manager === 'object' ? data.manager : null;
  state.workspaces = data.workspaces.filter(
    (workspace) => workspace && typeof workspace.id === 'string' && workspace.id !== '',
  );

  if (state.pendingSelectId && state.workspaces.some((workspace) => workspace.id === state.pendingSelectId)) {
    const target = state.pendingSelectId;
    state.pendingSelectId = null;
    selectWorkspace(target);
  } else {
    ensureSelection();
  }

  renderWorkspaceList();
  renderDetailHeader();
  updateChannelHealth();
  syncPairingsFromState();
}

async function refreshState() {
  const seq = ++state.stateSeq;
  try {
    const data = await api('/api/state');
    if (seq !== state.stateSeq) return;
    const wasOnline = state.online;
    state.online = true;
    applyState(data);
    renderManagerStatus();
    if (wasOnline === false) toast('已重新连接 manager', 'success');
  } catch (error) {
    if (seq !== state.stateSeq) return;
    const wasOnline = state.online;
    state.online = false;
    renderManagerStatus();
    renderWorkspaceList();
    if (wasOnline !== false) {
      toast(`无法获取 manager 状态：${error.message}`, 'error');
    }
  } finally {
    schedulePoll();
  }
}

function schedulePoll() {
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = window.setTimeout(() => {
    state.pollTimer = null;
    if (document.hidden) {
      schedulePoll();
      return;
    }
    void refreshState();
  }, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireEvents() {
  $('add-workspace-btn').addEventListener('click', openAddDialog);
  $('empty-add-btn').addEventListener('click', openAddDialog);

  const dialog = $('add-dialog');
  $('add-form').addEventListener('submit', onAddSubmit);
  $('add-cancel').addEventListener('click', () => {
    if (!state.addBusy) dialog.close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && !state.addBusy) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (state.addBusy) event.preventDefault();
  });
  $('add-name').addEventListener('input', hideFormError);
  $('add-dir').addEventListener('input', hideFormError);

  $('btn-start').addEventListener('click', () => {
    void runAction('start');
  });
  $('btn-stop').addEventListener('click', () => {
    void runAction('stop');
  });
  $('btn-restart').addEventListener('click', () => {
    void runAction('restart');
  });
  $('btn-delete').addEventListener('click', () => {
    void deleteWorkspace();
  });

  $('btn-reload-config').addEventListener('click', () => {
    if (state.selectedId) void loadConfig(state.selectedId);
  });
  $('btn-refresh-pairing').addEventListener('click', () => {
    if (state.selectedId) void loadPairing(state.selectedId);
  });
  $('btn-refresh-logs').addEventListener('click', () => {
    if (state.selectedId) void loadLogs(state.selectedId);
  });

  const connectDialog = $('connect-dialog');
  $('connect-close').addEventListener('click', () => closeConnectDialog({ userInitiated: true }));
  $('connect-cancel').addEventListener('click', () => closeConnectDialog({ userInitiated: true }));
  $('connect-manual-cancel').addEventListener('click', () => closeConnectDialog({ userInitiated: true }));
  $('connect-tab-qr').addEventListener('click', () => setConnectMode('qr'));
  $('connect-tab-manual').addEventListener('click', () => setConnectMode('manual'));
  $('connect-regenerate').addEventListener('click', () => beginConnect());
  $('connect-manual-submit').addEventListener('click', () => {
    if (connect.session) void saveManualConnect(connect.session);
  });
  $('connect-app-id').addEventListener('input', hideManualError);
  $('connect-app-secret').addEventListener('input', hideManualError);
  // X / Esc / backdrop all mean "cancel before confirmed".
  connectDialog.addEventListener('click', (event) => {
    if (event.target === connectDialog) closeConnectDialog({ userInitiated: true });
  });
  connectDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeConnectDialog({ userInitiated: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshState();
  });
}

function init() {
  wireEvents();
  renderManagerStatus();
  clearDetail();
  void refreshState();
}

init();
