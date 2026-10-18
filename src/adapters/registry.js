/**
 * Built-in channel adapter registry. Adapters are imported lazily so a missing
 * optional platform SDK only disables its own channel.
 */

const LOADERS = {
  feishu: () => import('./feishu/index.js'),
  dingtalk: () => import('./dingtalk/index.js'),
  wecom: () => import('./wecom/index.js'),
  weixin: () => import('./weixin/index.js'),
};

/** @type {string[]} */
export const ADAPTER_IDS = Object.keys(LOADERS);

/**
 * Normalize the many reasonable ways an adapter module can expose itself:
 *   export default adapter
 *   export default function createAdapter(config)
 *   export function createAdapter(config)
 *   export const adapter
 *
 * @param {any} module
 * @param {Record<string, any>} channelConfig
 * @returns {Promise<any>}
 */
async function materialize(module, id) {
  let candidate = module?.default ?? module?.adapter;
  // Adapters are stateful and must never be shared between gateway instances
  // (manager runs one gateway per workspace). Prefer a factory so every load
  // returns a fresh instance; `createAdapter` is the generic alias, while
  // `createFeishuAdapter` / `createWecomAdapter` are package-specific names.
  const factory =
    (typeof module?.createAdapter === 'function' ? module.createAdapter : undefined)
    ?? (typeof module?.[`create${id.charAt(0).toUpperCase()}${id.slice(1)}Adapter`] === 'function'
      ? module[`create${id.charAt(0).toUpperCase()}${id.slice(1)}Adapter`]
      : undefined);
  if (factory !== undefined) candidate = await factory();
  else if (typeof candidate === 'function') candidate = await candidate();
  if (candidate === undefined || candidate === null) {
    candidate = module;
  }
  return candidate;
}

/**
 * Load one adapter and verify the minimum contract.
 * @param {string} id
 * @param {{ channelConfig?: Record<string, any> }} [options]
 * @returns {Promise<import('../core/types.js').Adapter>}
 */
export async function loadAdapter(id, options = {}) {
  const loader = LOADERS[id];
  if (loader === undefined) throw new Error(`unknown channel adapter: ${id} (known: ${ADAPTER_IDS.join(', ')})`);
  let module;
  try {
    module = await loader();
  } catch (error) {
    throw new Error(
      `channel "${id}" adapter failed to load: ${error instanceof Error ? error.message : String(error)}. `
        + 'Run `npm install` in dsh-im-manager first.',
    );
  }
  const adapter = await materialize(module, id);
  if (adapter === null || typeof adapter !== 'object') throw new Error(`channel "${id}" adapter has no default export`);
  if (typeof adapter.id !== 'string' || adapter.id.length === 0) throw new Error(`channel "${id}" adapter is missing id`);
  if (adapter.capabilities === undefined) throw new Error(`channel "${id}" adapter is missing capabilities`);
  for (const method of ['start', 'stop', 'send']) {
    if (typeof adapter[method] !== 'function') throw new Error(`channel "${id}" adapter is missing ${method}()`);
  }
  return adapter;
}

/**
 * Import an adapter module without instantiating it (used by `doctor`).
 * @param {string} id
 */
export async function loadAdapterModule(id) {
  const loader = LOADERS[id];
  if (loader === undefined) throw new Error(`unknown channel adapter: ${id}`);
  return loader();
}
