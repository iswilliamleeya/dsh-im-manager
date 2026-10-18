#!/usr/bin/env bash
# Verify that the DSH host plugin entry loads in a REAL harness profile without
# touching the live app profile or its patch layer.
#
# It creates a throwaway DSH_HOME, materializes the shipped `sdk` profile, installs
# this package with install/activate.sh in **manager mode**, boots the profile with
# stdin closed, and asserts the embedded manager started and stopped cleanly.
#
# Usage: bash install/verify-plugin.sh
# Env:
#   DSH_CLI       path to the `dsh` launcher (default: macOS app bundle path)
#   KEEP=1        keep the temp DSH_HOME and print its path
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
CLI="${DSH_CLI:-$APP_CLI}"
[ -x "$CLI" ] || { echo "FAIL: dsh CLI not found at $CLI (set DSH_CLI)" >&2; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not on PATH" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-im-manager-plugin.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "kept: $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

PROFILE="im-manager-verify"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"

echo "1/5 materialize profile '$PROFILE' from the shipped sdk template"
DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile sdk --dump-config >/dev/null

echo "2/5 install plugin into $HOME_DIR/profiles/$PROFILE (manager mode, port 0)"
DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" DSH_IM_MANAGER_PORT=0 DSH_IM_MANAGER_FILE="$HOME_DIR/im-manager/manager.json" bash "$ROOT/install/activate.sh" >/dev/null

echo "3/5 write empty manager.json (no workspaces; lifecycle only)"
mkdir -p "$HOME_DIR/im-manager"
cat > "$HOME_DIR/im-manager/manager.json" <<EOF
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 0 },
  "workspaces": []
}
EOF

echo "4/5 boot the profile (stdin closed)"
LOG="$TMP/boot.log"
DSH_HOME="$HOME_DIR" DSH_IM_MANAGER_PLUGIN_TRACE=1 "$CLI" "$PROFILE" < /dev/null > "$LOG" 2>&1 &
BOOT_PID=$!
for _ in $(seq 1 60); do
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$BOOT_PID" 2>/dev/null; then
  kill -9 "$BOOT_PID" 2>/dev/null || true
  echo "FAIL: profile did not exit on stdin EOF" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "5/5 assertions"
fail() { echo "FAIL: $*" >&2; cat "$LOG" >&2; exit 1; }
grep -q "plugin apply: registering tools" "$LOG" || fail "plugin apply did not run"
grep -q "manager mode: owned" "$LOG" || fail "embedded manager did not start in owned mode"
grep -q "plugin dispose: stopping embedded manager" "$LOG" || fail "plugin dispose did not stop the manager"
grep -q "did not activate" "$LOG" && fail "loader reported an inactive entry"
if [ -f "$HOME_DIR/im-manager/manager.lock" ]; then
  fail "manager.lock was not released on dispose"
fi

echo "OK: host plugin loaded in manager mode, started the embedded manager, and disposed cleanly"
echo "manager file: $HOME_DIR/im-manager/manager.json"
