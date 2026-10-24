/**
 * Host-side RPC surface for the DSH client plugin.
 *
 * The native DSH page must not depend on the manager's loopback HTTP port or
 * CORS. Instead the host plugin registers a generic Connection RPC channel
 * (`/im-manager`) and dispatches small JSON endpoints to the embedded manager.
 * The browser half calls it through `ctx.connection.rpc.call(...)`; the same
 * channel works on the web carrier and the Desktop shell carrier.
 *
 * The handler is framework-free and unit-tested with a fake manager.
 */

/**
 * @param {any} manager
 * @returns {(endpoint: string, payload?: any, signal?: AbortSignal, peer?: any) => Promise<any>}
 */
export function createManagerRpcHandler(manager, options = {}) {
  if (manager === null || typeof manager !== 'object') {
    throw new TypeError('createManagerRpcHandler requires a manager instance');
  }

  /** @param {unknown} value */
  const ok = (value) => ({ ok: true, value });
  /** @param {unknown} error */
  const fail = (error) => {
    const code = typeof error?.code === 'string' ? error.code : 'IM_MANAGER_ERROR';
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code, message, details: {} } };
  };
  /** @param {any} payload */
  const requireWorkspace = (payload) => {
    if (payload === null || typeof payload !== 'object' || typeof payload.id !== 'string' || payload.id.length === 0) {
      const error = new Error('workspace id is required');
      error.code = 'INVALID_INPUT';
      throw error;
    }
    return payload.id;
  };
  const requireUpdate = () => {
    if (options.update === null || typeof options.update !== 'object') {
      throw Object.assign(new Error('version update is unavailable in this host build'), { code: 'UPDATE_UNAVAILABLE' });
    }
    return options.update;
  };

  /**
   * @param {string} endpoint
   * @param {any} payload
   */
  async function dispatch(endpoint, payload) {
    switch (endpoint) {
      case 'state':
        return ok(await manager.getState());

      case 'discover':
        if (typeof options.discover === 'function') return ok(await options.discover());
        return ok({ workspaces: [], unlinked: (await manager.getState())?.workspaces ?? [] });

      case 'workspace.adopt':
        if (typeof manager.adoptWorkspace !== 'function') throw Object.assign(new Error('workspace adoption is unavailable'), { code: 'UNSUPPORTED' });
        return ok(await manager.adoptWorkspace(payload ?? {}));

      case 'activity':
        return ok(await manager.getSessionActivity());

      case 'workspace.add': {
        if (payload === null || typeof payload !== 'object') throw Object.assign(new Error('payload is required'), { code: 'INVALID_INPUT' });
        if (typeof payload.name !== 'string' || payload.name.trim().length === 0) throw Object.assign(new Error('name is required'), { code: 'INVALID_INPUT' });
        if (typeof payload.workspaceDir !== 'string' || payload.workspaceDir.trim().length === 0) throw Object.assign(new Error('workspaceDir is required'), { code: 'INVALID_INPUT' });
        const workspace = await manager.addWorkspace({
          name: payload.name.trim(),
          workspaceDir: payload.workspaceDir.trim(),
          channels: Array.isArray(payload.channels) ? payload.channels : [],
          autoStart: payload.autoStart === true,
        });
        return ok(workspace);
      }

      case 'workspace.update': {
        const id = requireWorkspace(payload);
        const patch = {};
        if (typeof payload.name === 'string' && payload.name.trim().length > 0) patch.name = payload.name.trim();
        if (typeof payload.autoStart === 'boolean') patch.autoStart = payload.autoStart;
        return ok(await manager.updateWorkspace(id, patch));
      }

      case 'workspace.start': {
        const id = requireWorkspace(payload);
        return ok(await manager.startWorkspace(id));
      }

      case 'workspace.stop': {
        const id = requireWorkspace(payload);
        return ok(await manager.stopWorkspace(id));
      }

      case 'workspace.restart': {
        const id = requireWorkspace(payload);
        return ok(await manager.restartWorkspace(id));
      }

      case 'workspace.remove': {
        const id = requireWorkspace(payload);
        await manager.removeWorkspace(id);
        return ok({ id });
      }

      case 'config.get': {
        const id = requireWorkspace(payload);
        return ok(await manager.getWorkspaceConfig(id));
      }

      case 'config.save': {
        const id = requireWorkspace(payload);
        if (payload.config === null || typeof payload.config !== 'object') {
          throw Object.assign(new Error('config is required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.saveWorkspaceConfig(id, payload.config));
      }

      case 'pairing.list': {
        const id = requireWorkspace(payload);
        return ok({ pending: await manager.listPairing(id) });
      }

      case 'pairing.approve': {
        const id = requireWorkspace(payload);
        if (typeof payload.code !== 'string' || payload.code.trim().length === 0) {
          throw Object.assign(new Error('code is required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.approvePairing(id, payload.code.trim()));
      }

      case 'pairing.allow': {
        const id = requireWorkspace(payload);
        if (typeof payload.channel !== 'string' || payload.channel.length === 0) {
          throw Object.assign(new Error('channel is required'), { code: 'INVALID_INPUT' });
        }
        if (typeof payload.senderId !== 'string' || payload.senderId.length === 0) {
          throw Object.assign(new Error('senderId is required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.allowSender(id, {
          channel: payload.channel,
          senderId: payload.senderId,
          ...(typeof payload.name === 'string' && payload.name.length > 0 ? { name: payload.name } : {}),
        }));
      }

      case 'connect.begin': {
        const id = requireWorkspace(payload);
        if (typeof payload.channel !== 'string' || payload.channel.length === 0) {
          throw Object.assign(new Error('channel is required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.beginChannelConnect(id, payload.channel, { mode: 'qr' }));
      }

      case 'connect.get': {
        const id = requireWorkspace(payload);
        if (typeof payload.channel !== 'string' || payload.channel.length === 0) {
          throw Object.assign(new Error('channel is required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.getChannelConnect(id, payload.channel));
      }

      case 'connect.cancel': {
        const id = requireWorkspace(payload);
        if (typeof payload.channel !== 'string' || payload.channel.length === 0) {
          throw Object.assign(new Error('channel is required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.cancelChannelConnect(id, payload.channel));
      }

      case 'logs': {
        const id = requireWorkspace(payload);
        const lines = Number.isInteger(payload.lines) && payload.lines > 0 ? Math.min(payload.lines, 500) : 200;
        return ok({ lines: await manager.getLogs(id, lines) });
      }

      case 'message.send': {
        const id = requireWorkspace(payload);
        if (typeof payload.channel !== 'string' || typeof payload.conversationId !== 'string' || typeof payload.text !== 'string') {
          throw Object.assign(new Error('channel, conversationId and text are required'), { code: 'INVALID_INPUT' });
        }
        return ok(await manager.sendMessage(id, {
          channel: payload.channel,
          text: payload.text,
          target: {
            channel: payload.channel,
            accountId: payload.channel,
            conversationId: payload.conversationId,
            conversationType: payload.conversationType === 'group' ? 'group' : 'dm',
            ...(typeof payload.replyToMessageId === 'string' ? { replyToMessageId: payload.replyToMessageId } : {}),
          },
        }));
      }

      case 'update.state': {
        const update = requireUpdate();
        return ok(await update.getState());
      }

      case 'update.check': {
        const update = requireUpdate();
        return ok(await update.check({}));
      }

      case 'update.install': {
        const update = requireUpdate();
        return ok(await update.install({}));
      }

      default:
        throw Object.assign(new Error(`unknown endpoint: ${endpoint}`), { code: 'UNKNOWN_ENDPOINT' });
    }
  }

  return async function handleRpc(endpoint, payload, _signal, peer) {
    // Only the workspace owner may drive channel automation. Browser peers are
    // owner-scoped in DSH, but keep the check explicit for other carriers.
    if (peer !== undefined && peer !== null && peer.principal !== undefined && peer.principal?.kind !== 'owner') {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'only the workspace owner may manage IM channels', details: {} } };
    }
    try {
      return await dispatch(endpoint, payload ?? {});
    } catch (error) {
      return fail(error);
    }
  };
}
