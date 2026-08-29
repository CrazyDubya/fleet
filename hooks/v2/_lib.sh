#!/usr/bin/env bash
# shared by hooks/v2/*.sh — sourced, never executed
FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FLEET="$FLEET_ROOT/bin/fleet"
export FLEET_PROFILE="${FLEET_PROFILE:-v2}"
command -v jq >/dev/null 2>&1 || exit 0
PAYLOAD="$(cat 2>/dev/null || true)"
jf() { printf '%s' "$PAYLOAD" | jq -r "$1 // empty" 2>/dev/null || true; }
CWD="$(jf .cwd)"
THREAD=""
case "$CWD" in "$FLEET_ROOT"/*) THREAD="${CWD#"$FLEET_ROOT"/}"; THREAD="${THREAD%%/*}";; esac
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
ledger() { # hook decision why...
  local ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - T0 ))
  "$FLEET" hook-event "$1" "${THREAD:-?}" "$2" "$ms" "${@:3}" >/dev/null 2>&1 || true
}
