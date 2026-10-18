/**
 * Merge the DSH Workspace registry (current profile) with manager gateway
 * entries for the native GUI.
 *
 * DSH owns the workspace list and names; the manager owns gateway bindings and
 * channel configuration. A workspace without a manager entry is shown as
 * "no gateway yet"; manager entries whose directory is not registered in this
 * profile are returned separately as `unlinked` so they never disappear.
 */

/** @param {string} value */
function normalizePath(value) {
  return value.replace(/[\\/]+$/, '');
}

/** @param {string} value */
function basenameOf(value) {
  const segments = normalizePath(value).split(/[\\/]/);
  return segments.at(-1) ?? value;
}

/**
 * @param {any} state manager getState() result
 * @param {Array<{ id: string, path: string, title?: string, updatedAt?: string }>} registryEntities workspaceRegistry.list()
 */
export function mergeDiscoveredWorkspaces(state, registryEntities) {
  const managerEntries = Array.isArray(state?.workspaces) ? state.workspaces : [];
  const byPath = new Map();
  for (const entry of managerEntries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.workspaceDir !== 'string') continue;
    byPath.set(normalizePath(entry.workspaceDir), entry);
  }

  const workspaces = [];
  const linked = new Set();
  for (const entity of Array.isArray(registryEntities) ? registryEntities : []) {
    if (entity === null || typeof entity !== 'object' || typeof entity.path !== 'string') continue;
    const manager = byPath.get(normalizePath(entity.path));
    if (manager !== undefined) linked.add(normalizePath(entity.path));
    workspaces.push({
      workspaceId: String(entity.id ?? ''),
      title: typeof entity.title === 'string' && entity.title.length > 0 ? entity.title : (manager?.name ?? basenameOf(entity.path)),
      path: entity.path,
      updatedAt: typeof entity.updatedAt === 'string' ? entity.updatedAt : '',
      managerId: manager?.id ?? null,
      gateway: manager === undefined ? null : {
        state: manager.state,
        bridge: manager.bridge,
        sessions: manager.sessions,
        autoStart: manager.autoStart,
        channels: Array.isArray(manager.channels) ? manager.channels : [],
        pendingPairings: Array.isArray(manager.pendingPairings) ? manager.pendingPairings : [],
        error: manager.error ?? null,
        http: manager.http ?? null,
      },
    });
  }

  const unlinked = managerEntries
    .filter((entry) => typeof entry.workspaceDir === 'string' && !linked.has(normalizePath(entry.workspaceDir)))
    .map((entry) => ({
      managerId: entry.id,
      name: entry.name,
      workspaceDir: entry.workspaceDir,
      state: entry.state,
      bridge: entry.bridge,
      sessions: entry.sessions,
      autoStart: entry.autoStart,
      channels: Array.isArray(entry.channels) ? entry.channels : [],
      pendingPairings: Array.isArray(entry.pendingPairings) ? entry.pendingPairings : [],
      error: entry.error ?? null,
    }));

  return { workspaces, unlinked };
}
