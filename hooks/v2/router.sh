#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
PROMPT="$(jf .prompt)"
# only packets without a lane get routed; plain chat passes through
case "$PROMPT" in @to*) ;; *) exit 0;; esac
grep -q '@lane ' <<<"${PROMPT%%$'\n'*}" && exit 0
BODY="${PROMPT#*$'\n'}"

# FLEET-FIX item 7 (2026-09-06): the classifier this call injected a verdict from is retired
# (commit 702cc94 -- haiku-router2 now runs the plain fs brief). A present response from it is
# a real fs-tool answer, not a lane verdict, and injecting THAT as `[router] <line>` is worse
# than injecting nothing: a wrong-but-present verdict is indistinguishable from a real one to
# anything downstream that trusts the `[router]` prefix (protocol item 2 in every brief still
# says to "follow it or override"). Disabled rather than deleted, per the operator's own call:
# the mechanism may come back if the fleet ever grows past the point where every lane can be
# set by hand, and this file is where it would be re-enabled from.
#
# To re-enable: restore the block below (git log this file for the prior version) and repoint
# it at a thread that actually classifies -- not haiku-router2 as it stands today.
ledger router allow "router injection disabled - haiku-router2 role retired, see FLEET-AUDIT"
exit 0

# --- disabled call, kept for reference; unreachable, `exit 0` above always returns first ---
# VERDICT="$("$FLEET" ask haiku-router2 --from "$THREAD" --timeout 8 "$BODY" 2>/dev/null | head -1)"
# if [ -n "$VERDICT" ]; then
#   echo "[router] $VERDICT"
#   ledger router inject "$VERDICT"
# else
#   ledger router allow "router unavailable"
# fi
