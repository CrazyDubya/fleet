#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
TOOL="$(jf .tool_name)"
emit() { printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"%s"%s}}}\n' "$1" "${2:-}"; }
if [ "$TOOL" = "mcp__playwright__browser_navigate" ]; then
  # The browser may only open loopback pages (the local static server / fleet GUI):
  # anything else is SSRF from a thread that carries the GUI's cookie jar.
  URL="$(jf .tool_input.url)"
  case "$URL" in
    # A userinfo component (anything before an '@' in the authority) lets a URL like
    # http://127.0.0.1:@evil.com/ match the loopback glob below on its host prefix while a
    # real browser resolves the *host* to evil.com. Reject any authority containing '@'
    # before the loopback check runs.
    http://*@*|https://*@*) ledger perm deny "navigate $URL"; emit deny ',"message":"userinfo not allowed in browser_navigate URLs"';;
    http://127.0.0.1[:/]*|http://localhost[:/]*|http://\[::1\][:/]*|back|forward) ledger perm allow-auto "navigate $URL"; emit allow;;
    *) ledger perm deny "navigate $URL"; emit deny ',"message":"browser_navigate is limited to loopback URLs"';;
  esac
  exit 0
fi
[ "$TOOL" = "Bash" ] || exit 0          # other non-Bash prompts fall through to the UI
CMD="$(jf .tool_input.command)"; [ -n "$CMD" ] || exit 0
D="$("$FLEET" perm-decide "$THREAD" "$CWD" "$CMD" 2>/dev/null || echo escalate-timeout)"
case "$D" in
  allow-auto) ledger perm allow-auto "$CMD"; emit allow;;
  allow)      ledger perm allow "operator"; emit allow;;
  deny)       ledger perm deny "$CMD"; emit deny ',"message":"denied by fleet perm policy or operator"';;
  *)          ledger perm escalate-timeout "$CMD"; exit 0;;   # fall through to the normal prompt
esac
exit 0
