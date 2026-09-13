#!/usr/bin/env bash
set -u
# PreToolUse for Read/Edit/Write/NotebookEdit.
#
# The file tools were the other half of the credential hole, and the worse
# half: under bypassPermissions --add-dir does not confine Read (verified live -
# a tool thread read /etc/hosts on request), and no hook matched these tools at
# all, so the only thing in front of them was each settings file's enumerated
# Read() deny list. Three globs on the tool tier, against 88 home-level
# dot-directories on this machine.
#
# Same oracle as gate.sh, one policy: `fleet path-check` calls the same
# fleet.prompts rules that judge a path named on a Bash command line. A
# credential refused to `cat` must not be one Read call away, and a second
# implementation of "which paths are sensitive" would drift within the month.
#
# HOOK_FAILS_CLOSED like gate.sh: this hook has no PermissionRequest behind it
# on the tool tier either, so "no policy decision possible" cannot read as yes.
# The blast radius of a missing jq is the whole fleet - but it already is, since
# gate.sh dies the same way and nothing runs without Bash.
HOOK_FAILS_CLOSED=1
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
[ -n "$THREAD" ] || exit 0
TOOL="$(jf .tool_name)"
case "$TOOL" in
  Read|Edit|Write|NotebookEdit) ;;
  *) exit 0;;
esac
# NotebookEdit names its target notebook_path; the other three use file_path.
P="$(jf .tool_input.file_path)"
[ -n "$P" ] || P="$(jf .tool_input.notebook_path)"
[ -n "$P" ] || exit 0
block() { ledger files block "$1"; echo "$1" >&2; exit 2; }
PC_OUT="$("$FLEET" path-check --thread "$THREAD" --cwd "$CWD" -- "$P" 2>/dev/null)"; PC_RC=$?
if [ "$PC_RC" -ne 0 ]; then
  block "fleet path-check failed (exit $PC_RC) - refusing rather than silently allowing: $P"
fi
read -r PC_VERDICT PC_FALL PC_WHY <<<"$PC_OUT"
case "$PC_VERDICT" in
  ok) ;;
  deny) block "fleet perm policy denies this path ($PC_WHY); ask the operator instead: $P";;
  escalate)
    [ "$PC_FALL" = "prompt" ] || block "fleet perm policy escalates this path ($PC_WHY) and this thread has no operator prompt behind the gate; ask the operator instead: $P"
    ledger files escalate "$TOOL deferred ($PC_WHY): $P"; exit 0;;
  *) block "fleet path-check gave no usable verdict (${PC_VERDICT:-empty}) - refusing rather than silently allowing: $P";;
esac
ledger files allow "$TOOL $P"
exit 0
