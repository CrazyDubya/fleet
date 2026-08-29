#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
[ "$(jf .stop_hook_active)" = "true" ] && exit 0   # never loop on our own block
PEND="$FLEET_ROOT/state/$FLEET_PROFILE/pending/$THREAD.json"
[ -s "$PEND" ] || { ledger hold allow none; exit 0; }
# Only entries younger than STALE_S count. A pending entry outlives its reply
# whenever the waiter died without clearing it (a crashed `fleet ask`, a killed
# pane, a paste that never landed), and blocking a Stop forever on a reply that
# is never coming is worse than missing one: the thread cannot end any turn
# until an operator intervenes. 120 s is well past the ~2 s lookup round trip
# and past `fleet ask`'s own 30 s default timeout.
STALE_S=120
FRESH=$(jq -c --argjson max "$STALE_S" '[.[] | select((now - (.t // 0)) < $max)]' "$PEND" 2>/dev/null || echo '[]')
N=$(printf '%s' "$FRESH" | jq 'length' 2>/dev/null || echo 0)
[ "$N" -gt 0 ] || { ledger hold allow none-fresh; exit 0; }
TO=$(printf '%s' "$FRESH" | jq -r '.[0].to'); ID=$(printf '%s' "$FRESH" | jq -r '.[0].id')
ledger hold block "pending reply $ID from $TO"
echo "A reply from $TO (packet $ID) is still pending. Do not end the turn waiting for it: run \`fleet ask $TO \"...\"\` (synchronous) to get it now, or \`fleet miss $THREAD abandoned-$ID\` to drop it." >&2
exit 2
