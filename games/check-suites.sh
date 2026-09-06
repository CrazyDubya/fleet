#!/usr/bin/env bash
# Run every pinball suite, because they share code across project boundaries.
#
# games/pinball-lab and games/pinball-sandbox both import games/pinball/src/physics/*
# directly. A change to the game's solver silently changes both consumers, and neither
# project's own suite covers the others.
#
# That is not hypothetical. On 2026-09-04 the flipper sub-stepping fix (abd4e88) landed
# green on games/pinball at 98 pass, and simultaneously turned two games/pinball-lab
# instrument tests red — a cradle trial that used to settle now runs to timeout, because
# pinball-lab/src/instrument.js imports the very `advance()` that changed. Both the author
# and the reviewer ran only the suite of the project they had edited. It was caught hours
# later by chance, after the corpora that depend on that solver had already been measured.
#
# Run this before any handoff that touches games/pinball/src/physics/ or src/table/.
#
# Exits non-zero if any suite fails. Prints one line per project either way.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

status=0
for proj in pinball pinball-lab pinball-sandbox; do
  if [ ! -d "$proj" ]; then
    printf '%-18s SKIP (not present)\n' "$proj"
    continue
  fi
  # Capture unpiped exit status: `node --test | grep` reports grep's status, which has
  # produced false greens here before.
  out="$(cd "$proj" && node --test 2>&1)"
  rc=$?
  line="$(printf '%s\n' "$out" | grep -E '^. (pass|fail|skipped) ' | tr -d '\n' | tr -s ' ')"
  # Liveness, not just safety. `node --test` that discovers no files exits 0 and reports
  # "pass 0 fail 0" — so a renamed directory, a broken glob, or a runner that stopped
  # finding tests reads exactly like a clean run. Verified 2026-09-06: three empty dirs
  # through this script printed "VERDICT: all suites passed" and exit 0.
  #
  # Every failure condition above is existential ("did anything fail?"), and an empty set
  # satisfies all of them. This is the one conjunct that requires something to have
  # happened, so a suite that vanished cannot pass by having nothing to fail on.
  passed="$(printf '%s\n' "$out" | sed -n 's/^. pass \([0-9][0-9]*\).*/\1/p' | head -1)"
  if [ "$rc" -eq 0 ] && [ "${passed:-0}" -eq 0 ]; then
    status=1
    printf '%-18s FAIL  %s  <- ran zero tests\n' "$proj" "$line"
    printf '    node --test exited 0 but collected nothing. The suite did not pass; it did\n'
    printf '    not run. Check the directory, the test glob, and that files still match.\n'
  elif [ "$rc" -eq 0 ]; then
    printf '%-18s OK    %s\n' "$proj" "$line"
  else
    status=1
    printf '%-18s FAIL  %s\n' "$proj" "$line"
    printf '%s\n' "$out" | sed -n '/failing tests/,$p' | head -30 | sed 's/^/    /'
  fi
done

if [ "$status" -ne 0 ]; then
  echo
  echo "At least one suite failed. If you changed games/pinball/src/physics/, the consumers"
  echo "(pinball-lab, pinball-sandbox) import it directly — a red there is your change, not theirs."
fi

# A verdict line, because the exit status is easy to lose. `./check-suites.sh | grep ...`
# reports grep's status, not this script's — the operator did exactly that on 2026-09-04 and
# read a red board as green. Anyone filtering the output still sees this line.
if [ "$status" -eq 0 ]; then
  echo "VERDICT: all suites passed"
else
  echo "VERDICT: SUITE FAILURES PRESENT — see above (exit 1)"
fi
exit "$status"
