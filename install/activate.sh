#!/usr/bin/env bash
# Install / remove the dsh-im-manager host plugin in a DSH profile.
#
# This script installs the DSH profile bundle without pnpm: it copies the
# package into the profile and appends the host-plugin patch row. Standalone
# `serve` / CLI `manager` / Web UI entry points have been removed.
#
# Usage:
#   bash install/activate.sh              # manager mode (default): embed manager + native DSH page
#   DSH_PROFILE=web bash install/activate.sh
#   bash install/activate.sh --gateway    # legacy single-gateway mode
#   bash install/activate.sh --remove     # remove the patch row (package left in place)
#
# What it does:
#   1. copies this package into $DSH_HOME/profiles/<profile>/node_modules/dsh-im-manager
#      (including node_modules, so the channel SDKs resolve from the package itself)
#   2. appends an `im-manager` insert row to the profile patch layer, with a
#      timestamped backup and a duplicate guard. Default row uses `mode: manager`
#      (multi-workspace manager started with the DSH host; if a manager
#      already holds `manager.lock`, the plugin attaches instead of duplicating).
#   3. prints how to verify and how to undo
#
# Never install manager mode into the `sdk` profile: the gateway spawns its own
# SDK runtime, so manager mode there would recurse. Use desktop/web instead.
#
# The patch layer is watched live by the harness, so installing may dispose a
# running session. It is the last step for a reason.
set -euo pipefail

PROFILE="${DSH_PROFILE:-desktop}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME_DIR/profiles/$PROFILE/node_modules/dsh-im-manager"
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
ROW_ID="im-manager"
MODE="manager"
MANAGER_PORT="${DSH_IM_MANAGER_PORT:-8788}"
MANAGER_FILE="${DSH_IM_MANAGER_FILE:-}"

if [ "${1:-}" = "--gateway" ]; then
  MODE="gateway"
fi

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -d "$HOME_DIR/profiles/$PROFILE" ] || fail "profile '$PROFILE' not found at $HOME_DIR/profiles/$PROFILE"
[ -f "$HOME_DIR/profiles/$PROFILE/package.json" ] || fail "profile package.json missing; is '$PROFILE' a dsh profile?"
[ -f "$PATCH" ] || fail "patch layer not found at $PATCH"

if [ "${1:-}" = "--remove" ]; then
  BACKUP="$PATCH.before-im-manager-remove-$(date +%Y%m%d-%H%M%S)"
  cp "$PATCH" "$BACKUP"
  # Remove the single insert row block by id, leaving every other row untouched.
  python3 - "$PATCH" "$ROW_ID" <<'PY'
import sys
path, row_id = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
out, skip = [], False
for line in lines:
    if line.strip().startswith('- insert:'):
        skip = False
    if line.strip() == f'- id: {row_id}':
        skip = True
        # Also drop the '- insert:' line immediately above if it becomes empty.
        if out and out[-1].strip() == '- insert:':
            out.pop()
        continue
    if skip:
        # Skip the row's body until the next top-level or insert entry.
        if line.startswith('    ') or line.startswith('      ') or line.strip() == '':
            continue
        skip = False
    out.append(line)
open(path, 'w', encoding='utf-8').write(''.join(out))
PY
  say "removed '$ROW_ID' from $PATCH (backup: $BACKUP)"
  say "restart DSH (or let the live patch watcher reload) to unload the plugin."
  exit 0
fi

[ -f "$SRC_DIR/package.json" ] || fail "package.json missing in $SRC_DIR"

say "1/3 copying package -> $DEST"
mkdir -p "$(dirname "$DEST")"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.smoke' --exclude '.git' --exclude 'test' --exclude 'docs' \
    --exclude 'state' --exclude '*.log' \
    "$SRC_DIR/" "$DEST/"
else
  fail "rsync not found"
fi

# In-box packages (@deepseek-ai/dsh-tools, schemastery) are resolved by the
# DSH loader through the installation scope; the plugin imports them lazily.

say "2/3 appending plugin row to $PATCH"
if grep -q "^[[:space:]]*- id: $ROW_ID$" "$PATCH"; then
  say "   SKIP: '$ROW_ID' row already present"
else
  BACKUP="$PATCH.before-im-manager-$(date +%Y%m%d-%H%M%S)"
  cp "$PATCH" "$BACKUP"
  say "   backup: $BACKUP"
  # A profile whose patch file is the empty sequence `[]` would become two YAML
  # documents if we appended a list item; drop the placeholder first.
  if [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
    grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" > "$PATCH.tmp" || true
    mv "$PATCH.tmp" "$PATCH"
  fi
  if [ "$MODE" = "gateway" ]; then
    cat >> "$PATCH" <<EOF

- insert:
    - id: $ROW_ID
      name: dsh-im-manager
      config:
        mode: gateway
        configFile: ""
        autoStart: true
EOF
  else
    cat >> "$PATCH" <<EOF

- insert:
    - id: $ROW_ID
      name: dsh-im-manager
      config:
        mode: manager
        managerFile: "$MANAGER_FILE"
        host: 127.0.0.1
        port: $MANAGER_PORT
        autoStart: true
        startAllWorkspaces: false
EOF
  fi
fi

say "3/3 verifying package resolution"
if (cd "$HOME_DIR/profiles/$PROFILE" && node -e 'const m = await import("dsh-im-manager"); if (typeof m.createGateway !== "function") throw new Error("missing createGateway"); console.log("   resolved: dsh-im-manager")'); then
  say "   OK"
else
  say "   WARN: package resolution failed; run: cd \"$HOME_DIR/profiles/$PROFILE\" && pnpm install"
fi

say ""
say "The harness watches the patch layer, so the plugin should load within a few seconds."
if [ "$MODE" = "gateway" ]; then
  say "Mode: gateway (legacy single workspace)"
  say "Config: ~/.dsh/im-manager/config.json (or set gateway configFile in the patch row)."
else
  say "Mode: manager (multi-workspace)"
  say "Manager: ~/.dsh/im-manager/manager.json"
  say "manager API: http://127.0.0.1:$MANAGER_PORT/  (attach/health; UI 在 DSH 侧栏「消息」)"
fi
say "Undo:  bash \"$SRC_DIR/install/activate.sh\" --remove"
