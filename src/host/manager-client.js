/**
 * Tiny JSON client for the manager HTTP API.
 *
 * The DSH host plugin uses this in both embedded (`owned`) and attached modes,
 * so its tools behave identically whether it owns the manager or talks to a
 * manager started by the CLI / another host.
 */

/** @param {string} baseUrl @param {{ fetchImpl?: typeof fetch }} [options] */
export function createManagerHttpClient(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [requestOptions]
   */
  async function request(path, requestOptions = {}) {
    const method = requestOptions.method ?? 'GET';
    const init = { method };
    if (requestOptions.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(requestOptions.body);
    }
    if (Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0) {
      init.signal = AbortSignal.timeout(requestOptions.timeoutMs);
    }
    const response = await fetchImpl(`${base}${path}`, init);
    let payload = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { message: text.slice(0, 300) } };
      }
    }
    if (!response.ok) {
      const message = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  return {
    baseUrl: base,
    request,
    /** @returns {Promise<any>} */
    getState() {
      return request('/api/state');
    },
    /** @param {string} workspaceId @param {string} code */
    approvePairing(workspaceId, code) {
      return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/pairing/approve`, {
        method: 'POST',
        body: { code },
      });
    },
    /** @param {string} workspaceId @param {{ channel: string, senderId: string, name?: string }} body */
    allowSender(workspaceId, body) {
      return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/pairing/allow`, {
        method: 'POST',
        body,
      });
    },
    /**
     * @param {string} workspaceId
     * @param {{ channel: string, conversationId: string, text: string, conversationType?: string, replyToMessageId?: string }} body
     */
    sendMessage(workspaceId, body) {
      return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/messages`, {
        method: 'POST',
        body,
      });
    },
  };
}

/**
 * Resolve a workspace from `/api/state`.
 *
 * `requested` may be an id, a name, or a workspace directory. Without it, a
 * unique running workspace is selected; multiple running workspaces require an
 * explicit choice so a tool never sends a message to the wrong workspace.
 *
 * @param {any} state
 * @param {string | undefined} requested
 */
export function pickWorkspace(state, requested) {
  const workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
  if (workspaces.length === 0) throw new Error('no workspaces configured in the manager');
  const needle = typeof requested === 'string' ? requested.trim() : '';
  if (needle.length > 0) {
    const match =
      workspaces.find((workspace) => workspace.id === needle)
      ?? workspaces.find((workspace) => workspace.name === needle)
      ?? workspaces.find((workspace) => workspace.workspaceDir === needle);
    if (match === undefined) {
      const ids = workspaces.map((workspace) => workspace.id).join(', ');
      throw new Error(`workspace "${needle}" not found (available: ${ids})`);
    }
    return match;
  }
  const running = workspaces.filter((workspace) => workspace.state === 'running');
  if (running.length === 1) return running[0];
  if (running.length === 0) {
    if (workspaces.length === 1) return workspaces[0];
    throw new Error('no running workspace; start one first (or pass workspace)');
  }
  const ids = running.map((workspace) => workspace.id).join(', ');
  throw new Error(`multiple running workspaces; pass workspace: <id> (available: ${ids})`);
}

/**
 * Turn the manager state into the flat output shape of `im_gateway_status`
 * (the DSH tool schema is shared with the single-gateway mode).
 *
 * @param {any} state
 * @param {string} baseUrl
 */
export function formatManagerStatus(state, baseUrl) {
  const workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
  const running = workspaces.filter((workspace) => workspace.state === 'running');
  const lines = [];
  const channelLines = [];
  const pendingLines = [];
  let sessions = 0;

  for (const workspace of workspaces) {
    const channels = Array.isArray(workspace.channels) ? workspace.channels : [];
    const channelText = channels.length === 0
      ? '(no enabled channel)'
      : channels.map((channel) => `${channel.id}:${channel.health || 'unknown'}`).join(', ');
    sessions += Number.isInteger(workspace.sessions) ? workspace.sessions : 0;
    lines.push(
      `- ${workspace.id} [${workspace.state}]${workspace.error ? ` error=${workspace.error}` : ''}`
        + ` bridge=${workspace.bridge ?? 'absent'} channels=${channelText} sessions=${workspace.sessions ?? 0}`,
    );
    for (const channel of channels) {
      channelLines.push(`  ${workspace.id}/${channel.id}: ${channel.health || 'unknown'}`);
    }
    for (const pending of Array.isArray(workspace.pendingPairings) ? workspace.pendingPairings : []) {
      pendingLines.push(`  ${pending.code}  ${workspace.id}/${pending.channel}:${pending.senderId}${pending.name ? ` (${pending.name})` : ''}`);
    }
  }

  const aggregateState = running.length > 0 ? 'running' : (workspaces[0]?.state ?? 'stopped');
  const bridges = [...new Set(workspaces.map((workspace) => workspace.bridge).filter(Boolean))];
  const detail = [
    `IM manager: ${running.length}/${workspaces.length} workspace(s) running`,
    `Manager: ${baseUrl}`,
    ...(lines.length > 0 ? lines : ['- (no workspaces configured)']),
    'Channels:',
    ...(channelLines.length > 0 ? channelLines : ['  (none)']),
    'Pending pairings:',
    ...(pendingLines.length > 0 ? pendingLines : ['  (none)']),
  ].join('\n');

  return {
    detail,
    state: aggregateState,
    bridge: bridges.length > 0 ? bridges.join(',') : 'absent',
    channels: channelLines.length > 0 ? channelLines.join('\n') : '(none)',
    sessions,
    http: baseUrl,
    pendingPairings: pendingLines.map((line) => line.trim()),
    workspace: workspaces.map((workspace) => workspace.id).join(',') || '(none)',
  };
}

/**
 * Adapt the manager HTTP API to the subset of the manager object used by the
 * host RPC handler. This lets native DSH UI work in `attach` mode (a CLI manager
 * owns the lock) without duplicating the RPC endpoints.
 *
 * @param {string} baseUrl
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createHttpManagerAdapter(baseUrl, options = {}) {
  const client = createManagerHttpClient(baseUrl, options);
  const wsPath = (id, suffix = '') => `/api/workspaces/${encodeURIComponent(id)}${suffix}`;

  return {
    baseUrl: client.baseUrl,
    getState: () => client.getState(),
    getSessionActivity: () => client.request('/api/sessions/activity'),
    addWorkspace: (input) => client.request('/api/workspaces', { method: 'POST', body: input }),
    async adoptWorkspace(input = {}) {
      const state = await client.getState();
      const workspaceDir = input.workspaceDir ?? input.path ?? '';
      const normalize = (value) => String(value).replace(/[\\/]+$/, '');
      const existing = (state?.workspaces ?? []).find((entry) => normalize(entry.workspaceDir) === normalize(workspaceDir));
      if (existing !== undefined) return existing;
      return client.request('/api/workspaces', {
        method: 'POST',
        body: {
          name: input.name ?? input.title ?? '',
          workspaceDir,
          channels: Array.isArray(input.channels) ? input.channels : [],
          autoStart: input.autoStart === true,
        },
      });
    },
    updateWorkspace: (id, patch) => client.request(wsPath(id), { method: 'PATCH', body: patch }),
    startWorkspace: (id) => client.request(wsPath(id, '/start'), { method: 'POST' }),
    stopWorkspace: (id) => client.request(wsPath(id, '/stop'), { method: 'POST' }),
    restartWorkspace: (id) => client.request(wsPath(id, '/restart'), { method: 'POST' }),
    removeWorkspace: (id) => client.request(wsPath(id), { method: 'DELETE' }),
    getWorkspaceConfig: (id) => client.request(wsPath(id, '/config')),
    saveWorkspaceConfig: (id, config) => client.request(wsPath(id, '/config'), { method: 'PUT', body: { config } }),
    async listPairing(id) {
      const result = await client.request(wsPath(id, '/pairing'));
      return Array.isArray(result?.pending) ? result.pending : [];
    },
    approvePairing: (id, code) => client.approvePairing(id, code),
    allowSender: (id, body) => client.allowSender(id, body),
    beginChannelConnect(id, channel, opts = {}) {
      return client.request(wsPath(id, `/channels/${encodeURIComponent(channel)}/connect`), {
        method: 'POST',
        body: { mode: opts.mode ?? 'qr' },
      });
    },
    getChannelConnect(id, channel) {
      return client.request(wsPath(id, `/channels/${encodeURIComponent(channel)}/connect`));
    },
    cancelChannelConnect(id, channel) {
      return client.request(wsPath(id, `/channels/${encodeURIComponent(channel)}/connect/cancel`), { method: 'POST' });
    },
    async getLogs(id, lines = 200) {
      const result = await client.request(wsPath(id, `/logs?lines=${encodeURIComponent(String(lines))}`));
      return Array.isArray(result?.lines) ? result.lines : [];
    },
    sendMessage(id, input) {
      return client.request(wsPath(id, '/messages'), {
        method: 'POST',
        body: {
          channel: input.channel,
          conversationId: input.target?.conversationId,
          text: input.text,
          conversationType: input.target?.conversationType,
          replyToMessageId: input.target?.replyToMessageId,
        },
      });
    },
  };
}
