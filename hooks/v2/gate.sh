#!/usr/bin/env bash
set -u
# FLEET-FIX item 2: this is the one hook that must hard-refuse rather than degrade when jq is
# missing -- it has no PermissionRequest-style fallthrough to a live human prompt (a PreToolUse
# hook has ~3s and no operator to wait for, per this file's own comment below), so "no policy
# decision possible" has to mean "block", not "allow through". See _lib.sh's own comment on
# HOOK_FAILS_CLOSED for why the other three hooks don't set this.
HOOK_FAILS_CLOSED=1
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
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
  # Resolve the positional destination of every `fleet send` in the command;
  # a glob on "opus" would also match --from opus2 or a refs path.
  DEST="$(python3 - "$CMD" <<'PY'
import shlex, sys
MULTI = {"--refs"}; ONE = {"--from", "--lane", "--effort", "--reply", "--done"}
try: toks = shlex.split(sys.argv[1])
except ValueError: toks = sys.argv[1].split()
out = []
i = 0
while i < len(toks):
    if toks[i].endswith("fleet") and i + 1 < len(toks) and toks[i + 1] == "send":
        j = i + 2
        while j < len(toks):
            t = toks[j]
            if t in MULTI:
                j += 1
                while j < len(toks) and not toks[j].startswith("-"): j += 1
            elif t in ONE: j += 2
            elif t == "--": j += 1
            elif t.startswith("-"): j += 1
            else: out.append(t); break
        i = j
    i += 1
print(" ".join(out))
PY
)"
  case " $DEST " in *" opus"*|*" fable"*)
    grep -Eq -- '--lane (plan|consult)|@override' <<<"$CMD" || block "fleet send to opus/fable needs --lane plan|consult or @override";;
  esac
  # Destructive gate for EVERY tier. The tool tier runs a permission mode that
  # never raises a PermissionRequest, so perm.sh never sees its Bash calls and
  # settings deny patterns are the only thing standing between a haiku thread
  # and `rm`/`git push`. PreToolUse does fire on all tiers: ask the same policy
  # (fleet.prompts.decide_auto) here and refuse the deny class. Escalation is
  # deliberately NOT done here - a hook has 3 s and no operator to wait for.
  #
  # FLEET-FIX item 3: was `"$FLEET" perm-check "$CMD" 2>/dev/null || echo ok` -- a crashed
  # perm-check (bad python, a broken bin/fleet, anything) silently read as "ok", the ONE path
  # in this hook set that failed open rather than closed. `perm-check` itself always exits 0
  # on a real answer (every verdict `return 0` in cmd_perm_check) and prints to stdout, so a
  # non-zero exit here is unambiguous: perm-check itself broke, not "it answered ok".
  # Captured separately from the exit check so this can't repeat the same
  # `$(... || fallback)` shape that caused the original bug.
  #
  # perm-check answers "<verdict> <fallthrough> <why>". It used to
  # answer "ok" for an escalate verdict, which flattened decide_auto's
  # three-way policy into a two-way one exactly here, in the one caller that
  # has nothing behind it: on the tool tier a non-loopback URL, a path outside
  # the thread's granted roots, or a quoted `rm` inside `python -c` all read as
  # sanctioned. Escalate is still NOT blocked for a thread whose permission
  # mode raises a PermissionRequest ("prompt") - blocking at PreToolUse would
  # pre-empt perm.sh and the operator dialog that resolves it, which is worse
  # than the gap. It IS blocked when the fallthrough is "none", because then
  # this hook is the last check that exists.
  if [ -n "$CMD" ]; then
    PC_OUT="$("$FLEET" perm-check --thread "$THREAD" --cwd "$CWD" -- "$CMD" 2>/dev/null)"; PC_RC=$?
    if [ "$PC_RC" -ne 0 ]; then
      block "fleet perm-check failed (exit $PC_RC) - refusing rather than silently allowing: $CMD"
    fi
    # "<verdict> <fallthrough> <why>". PC_WHY is the policy's own reason and it
    # goes into every block, so the operator can tell a real catch from a false
    # positive from the ledger alone.
    read -r PC_VERDICT PC_FALL PC_WHY <<<"$PC_OUT"
    case "$PC_VERDICT" in
      ok) ;;
      deny) block "fleet perm policy denies this command ($PC_WHY); ask the operator instead: $CMD";;
      escalate)
        [ "$PC_FALL" = "prompt" ] || block "fleet perm policy escalates this command ($PC_WHY) and this thread has no operator prompt behind the gate; ask the operator instead: $CMD"
        ledger gate escalate "deferred to PermissionRequest ($PC_WHY): $CMD"; exit 0;;
      # An unparseable verdict is not an answer, and per this hook's own rule a
      # non-answer must not read as yes.
      *) block "fleet perm-check gave no usable verdict (${PC_VERDICT:-empty}) - refusing rather than silently allowing: $CMD";;
    esac
  fi
fi
ledger gate allow ok; exit 0
