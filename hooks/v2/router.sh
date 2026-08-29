#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
PROMPT="$(jf .prompt)"
# only packets without a lane get routed; plain chat passes through
case "$PROMPT" in @to*) ;; *) exit 0;; esac
grep -q '@lane ' <<<"${PROMPT%%$'\n'*}" && exit 0
BODY="${PROMPT#*$'\n'}"
VERDICT="$("$FLEET" ask haiku-router2 --from "$THREAD" --timeout 8 "$BODY" 2>/dev/null | head -1)"
if [ -n "$VERDICT" ]; then
  echo "[router] $VERDICT"
  ledger router "$THREAD" inject "$VERDICT"
else
  ledger router "$THREAD" allow "router unavailable"
fi
exit 0
