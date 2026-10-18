/**
 * Attach externally created DSH sessions to their DSH workspace registration.
 *
 * The gateway spawns a separate `dsh --profile sdk` runtime, so its sessions are
 * written to the shared persistence but are not automatically "accounted" by the
 * host's workspace registry. Ungrouped sessions therefore fall into the GUI's
 * "未分组" bucket. `Workspace#attachSession` validates the stored header cwd
 * against the workspace path and adds the session to the workspace's ordered
 * membership; mutating the workspace emits a domain change that the client
 * workspace stream follows, so the sidebar re-groups the session.
 *
 * This helper is best-effort: a not-yet-persisted session, a workspace path that
 * is missing from the registry, or a header mismatch must never break the
 * activity RPC — the next poll retries.
 */

/**
 * @param {{ workspaces?: Array<{ id?: string, workspaceDir?: string, sessions?: Array<{ sessionId?: string }> }> }} activity
 * @param {{ resolveByPath(path: string): Promise<any> }} workspaceRegistry
 * @param {{ debug?: Function, warn?: Function }} [logger]
 * @returns {Promise<{ attached: string[], skipped: string[] }>}
 */
export async function attachSessionsToWorkspaces(activity, workspaceRegistry, logger) {
  const result = { attached: [], skipped: [] };
  if (activity === null || typeof activity !== 'object' || !Array.isArray(activity.workspaces)) return result;
  if (workspaceRegistry === null || typeof workspaceRegistry !== 'object' || typeof workspaceRegistry.resolveByPath !== 'function') {
    return result;
  }

  for (const workspace of activity.workspaces) {
    if (workspace === null || typeof workspace !== 'object') continue;
    const workspaceDir = typeof workspace.workspaceDir === 'string' ? workspace.workspaceDir : '';
    const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : [];
    if (workspaceDir.length === 0 || sessions.length === 0) continue;

    let entity;
    try {
      entity = await workspaceRegistry.resolveByPath(workspaceDir);
    } catch (error) {
      logger?.debug?.('workspace attach: registry path not resolvable', { workspaceDir, error });
      continue;
    }
    if (entity === null || entity === undefined) continue;

    for (const session of sessions) {
      if (session === null || typeof session !== 'object' || typeof session.sessionId !== 'string') continue;
      if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(session.sessionId)) {
        continue;
      }
      try {
        await entity.attachSession(session.sessionId);
        result.attached.push(session.sessionId);
      } catch (error) {
        // The header may not be persisted yet (first turn) or the cwd may not
        // match this workspace. Retry on the next activity tick.
        result.skipped.push(session.sessionId);
        logger?.debug?.('workspace attach: session not attachable yet', {
          sessionId: session.sessionId,
          workspaceDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}

/**
 * One-shot backfill for sessions that predate the activity hook (or were
 * created while the plugin was not running). Workspace startup bootstraps its
 * session account from persisted headers once; sessions persisted after that
 * point stay unaccounted until an attach runs. Scans every stored session header
 * through `ctx.sessionQuery` and attaches it to the workspace owning its cwd.
 *
 * Best-effort: unreadable logs, missing directories, and header validation
 * failures are counted and skipped rather than failing the host plugin.
 *
 * @param {{ resolveByPath(path: string): Promise<any> }} workspaceRegistry
 * @param {{ listSessions(signal?: AbortSignal): Promise<Array<{ header?: { id?: string, cwd?: string }, id?: string, cwd?: string }>> }} sessionQuery
 * @param {{ debug?: Function, warn?: Function }} [logger]
 * @returns {Promise<{ attached: number, skipped: number, scanned: number }>}
 */
export async function backfillWorkspaceSessions(workspaceRegistry, sessionQuery, logger) {
  const result = { attached: 0, skipped: 0, scanned: 0 };
  if (workspaceRegistry === null || typeof workspaceRegistry !== 'object' || typeof workspaceRegistry.resolveByPath !== 'function') return result;
  if (sessionQuery === null || typeof sessionQuery !== 'object' || typeof sessionQuery.listSessions !== 'function') return result;

  let records;
  try {
    records = await sessionQuery.listSessions();
  } catch (error) {
    logger?.warn?.('workspace backfill: listSessions failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  if (!Array.isArray(records)) return result;

  for (const record of records) {
    const header = record?.header ?? record;
    const sessionId = typeof header?.id === 'string' ? header.id : undefined;
    const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined;
    if (sessionId === undefined || cwd === undefined) continue;
    result.scanned += 1;

    let entity;
    try {
      entity = await workspaceRegistry.resolveByPath(cwd);
    } catch {
      continue;
    }
    if (entity === null || entity === undefined) continue;
    if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) continue;
    try {
      await entity.attachSession(sessionId);
      result.attached += 1;
    } catch (error) {
      result.skipped += 1;
      logger?.debug?.('workspace backfill: session skipped', {
        sessionId,
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (result.attached > 0) {
    logger?.info?.('workspace backfill attached sessions', result);
  }
  return result;
}
