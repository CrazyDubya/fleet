#!/usr/bin/env bash
# shared by hooks/v2/*.sh — sourced, never executed
FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FLEET="$FLEET_ROOT/bin/fleet"
export FLEET_PROFILE="${FLEET_PROFILE:-v2}"
command -v jq >/dev/null 2>&1 || exit 0
# Claude Code always pipes the hook payload in on stdin, so stdin is never a
# TTY here. Running one of these scripts by hand from a terminal is the only
# way it can be, and then `cat` blocks forever waiting for an EOF the operator
# has to guess at. Exit cleanly instead.
[ -t 0 ] && exit 0
PAYLOAD="$(cat 2>/dev/null || true)"
jf() { printf '%s' "$PAYLOAD" | jq -r "$1 // empty" 2>/dev/null || true; }
CWD="$(jf .cwd)"
THREAD=""
TRANSCRIPT_PATH="$(jf .transcript_path)"
# Primary: ask the registry which thread owns this session. session_id is the
# transcript's basename and is unique per thread, so this is exact and works
# for ANY cwd - including a thread that steers a repo outside FLEET_ROOT,
# where every path-shaped derivation below silently yields "?" and the ledger
# loses per-thread attribution for the whole session.
REG="$FLEET_ROOT/state/${FLEET_PROFILE}/registry.json"
[ "$FLEET_PROFILE" = "v1" ] && REG="$FLEET_ROOT/state/registry.json"
if [ -n "$TRANSCRIPT_PATH" ] && [ -r "$REG" ]; then
  SID="$(basename "$TRANSCRIPT_PATH" .jsonl)"
  THREAD="$(jq -r --arg s "$SID" \
    'to_entries[] | select(.value.session_id == $s) | .key' "$REG" 2>/dev/null | head -1)"
fi
# Secondary: derive THREAD from transcript_path, whose project-dir component
# fleet.paths.transcript_path builds as str(cwd).replace("/", "-") for a
# cwd of "$FLEET_ROOT/<thread>" - so the key is "$FLEET_ROOT" (slashes ->
# dashes) followed by "-<thread>". This survives the model `cd`-ing Bash's
# cwd elsewhere (e.g. to FLEET_ROOT itself), since transcript_path is fixed
# at session start. Caveat: a forked expert's transcript lives in its
# PARENT's project dir (fleet/registry.py:transcript_for), so THREAD then
# resolves to the parent's name - still a valid thread, just not the fork's.
if [ -z "$THREAD" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  PROJ="$(basename "$(dirname "$TRANSCRIPT_PATH")")"
  KEY="$(printf '%s' "$FLEET_ROOT" | tr '/' '-')"
  case "$PROJ" in "$KEY"-*) THREAD="${PROJ#"$KEY"-}";; esac
fi
# Fallback: derive from cwd directly (works when cwd is still inside the
# thread's own directory).
if [ -z "$THREAD" ]; then
  case "$CWD" in "$FLEET_ROOT"/*) THREAD="${CWD#"$FLEET_ROOT"/}"; THREAD="${THREAD%%/*}";; esac
fi
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
ledger() { # hook decision why...
  local ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - T0 ))
  "$FLEET" hook-event "$1" "${THREAD:-?}" "$2" "$ms" "${@:3}" >/dev/null 2>&1 || true
}
