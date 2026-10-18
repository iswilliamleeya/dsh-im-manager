/**
 * Resolve the `dsh` executable used to spawn the SDK runtime.
 *
 * `dsh` is not necessarily on PATH (the desktop app ships a self-contained CLI
 * inside its bundle), so detection is explicit and configurable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MAC_APP_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

/**
 * @param {(name: string) => string | null} which
 * @param {string} name
 * @returns {string | null}
 */
function whichCommand(which, name) {
  try {
    return which(name);
  } catch {
    return null;
  }
}

/**
 * @param {{ command?: string }} dsh
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   which?: (name: string) => string | null,
 * }} [options]
 * @returns {string}
 */
export function resolveDshCommand(dsh, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = String(dsh?.command ?? 'dsh');
  const which = options.which ?? ((name) => execFileSync('which', [name], { encoding: 'utf8' }).trim());

  // An explicit path (or a non-bare command) is used verbatim.
  if (configured.includes('/') || (platform === 'win32' && configured.includes('\\'))) return configured;

  // Environment override wins for the default command, so the same config works
  // on a laptop and on a server with a different install location.
  if (configured === 'dsh' && env.DSH_IM_MANAGER_DSH) return env.DSH_IM_MANAGER_DSH;

  const found = whichCommand(which, configured);
  if (found !== null && found.length > 0) return found;

  if (platform === 'darwin' && existsSync(MAC_APP_CLI)) return MAC_APP_CLI;
  return configured;
}
