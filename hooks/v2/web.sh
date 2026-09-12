#!/usr/bin/env bash
set -u
# PreToolUse for WebFetch/WebSearch.
#
# Bash egress is judged by fleet.prompts.decide_auto through gate.sh; WebFetch
# and WebSearch were judged by nothing at all, and left no trace either, so a
# thread fetching a URL was not merely ungated but invisible. This hook is the
# visibility half: every fetch and every search lands in the ledger with the
# thread that asked for it, which is what makes the remaining gap measurable
# instead of theoretical.
#
# Log-only by design, with one exception: a URL pointing at a known exfil sink
# (fleet.prompts.EXFIL_HOSTS, the same list the Bash path uses) is blocked, so
# that a sink refused to curl is not quietly reachable through WebFetch. A
# denylist catches the obvious and the careless; it is not a boundary, and it
# is not a reason to postpone real gating of this tool pair.
#
# Deliberately NOT HOOK_FAILS_CLOSED, unlike gate.sh: the job here is
# observability, and a missing jq turning every WebFetch in the fleet into a
# hard block would be a larger outage than the gap it covers. _lib.sh still
# logs the unavailability, so it cannot go dark silently.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
TOOL="$(jf .tool_name)"
if [ "$TOOL" = "WebSearch" ]; then
  ledger web allow "search: $(jf .tool_input.query)"
  exit 0
fi
[ "$TOOL" = "WebFetch" ] || exit 0
URL="$(jf .tool_input.url)"
[ -n "$URL" ] || exit 0
# A broken web-check logs and allows rather than blocking: see the fail-open
# note above. It is the one place in this file where that is the right default.
WC="$("$FLEET" web-check "$URL" 2>/dev/null)" || WC=""
case "$WC" in
  deny*)
    HOST="${WC#deny }"
    ledger web block "fetch $URL (exfil sink $HOST)"
    echo "WebFetch to $HOST is on the fleet exfil denylist; ask the operator" >&2
    exit 2;;
esac
ledger web allow "fetch $URL"
exit 0
