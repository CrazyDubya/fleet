#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
[ "$(jf .stop_hook_active)" = "true" ] && exit 0   # never loop on our own block
PEND="$FLEET_ROOT/state/$FLEET_PROFILE/pending/$THREAD.json"
[ -s "$PEND" ] || { ledger hold allow none; exit 0; }
N=$(jq 'length' "$PEND" 2>/dev/null || echo 0)
[ "$N" -gt 0 ] || { ledger hold allow none; exit 0; }
TO=$(jq -r '.[0].to' "$PEND"); ID=$(jq -r '.[0].id' "$PEND")
ledger hold block "pending reply $ID from $TO"
echo "A reply from $TO (packet $ID) is still pending. Do not end the turn waiting for it: run \`fleet ask $TO \"...\"\` (synchronous) to get it now, or \`fleet miss $THREAD abandoned-$ID\` to drop it." >&2
exit 2
