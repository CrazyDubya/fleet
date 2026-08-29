#!/usr/bin/env bash
set -u; source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
TOOL="$(jf .tool_name)"
block() { ledger gate block "$1"; echo "$1" >&2; exit 2; }
if [ "$TOOL" = "SendMessage" ]; then
  TO="$(jf .tool_input.to)"; MSG="$(jf .tool_input.message)"
  case "$TO" in haiku-*) block "use \`fleet ask $TO \"...\"\` - it is synchronous (1.5s) and returns the answer as a tool result";; esac
  case "$TO" in opus*|fable*)
    grep -Eq '@lane (plan|consult)|@override ' <<<"$MSG" || block "sends to $TO need @lane plan|consult (router verdict) or @override <reason>";;
  esac
  case "$MSG" in @to*) grep -Eq '@lane (lookup|judge)' <<<"$MSG" || grep -q '@done ' <<<"$MSG" || block "build/plan packets need a @done line";; esac
elif [ "$TOOL" = "Bash" ]; then
  CMD="$(jf .tool_input.command)"
  case "$CMD" in *"fleet send "*opus*|*"fleet send "*fable*)
    grep -Eq -- '--lane (plan|consult)|@override' <<<"$CMD" || block "fleet send to opus/fable needs --lane plan|consult or @override";;
  esac
  # Destructive gate for EVERY tier. The tool tier runs a permission mode that
  # never raises a PermissionRequest, so perm.sh never sees its Bash calls and
  # settings deny patterns are the only thing standing between a haiku thread
  # and `rm`/`git push`. PreToolUse does fire on all tiers: ask the same policy
  # (fleet.prompts.decide_auto) here and refuse the deny class. Escalation is
  # deliberately NOT done here - a hook has 3 s and no operator to wait for.
  if [ -n "$CMD" ] && [ "$("$FLEET" perm-check "$CMD" 2>/dev/null || echo ok)" = "deny" ]; then
    block "fleet perm policy denies this command; ask the operator instead: $CMD"
  fi
fi
ledger gate allow ok; exit 0
