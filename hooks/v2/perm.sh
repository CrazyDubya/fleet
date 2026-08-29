#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
[ "$(jf .tool_name)" = "Bash" ] || exit 0          # non-Bash prompts fall through to the UI
CMD="$(jf .tool_input.command)"; [ -n "$CMD" ] || exit 0
D="$("$FLEET" perm-decide "$THREAD" "$CWD" "$CMD" 2>/dev/null || echo escalate-timeout)"
emit() { printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"%s"%s}}}\n' "$1" "${2:-}"; }
case "$D" in
  allow-auto) ledger perm allow-auto "$CMD"; emit allow;;
  allow)      ledger perm allow "operator"; emit allow;;
  deny)       ledger perm deny "$CMD"; emit deny ',"message":"denied by fleet perm policy or operator"';;
  *)          ledger perm escalate-timeout "$CMD"; exit 0;;   # fall through to the normal prompt
esac
exit 0
