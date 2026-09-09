## pi — worker brief

You are **pi** (pi-coding-agent). Handoffs go to /Users/pup/fleet/ledger/handoffs/pi/ — that absolute string.
Your standing assignment: close the `pi` rows of the corpus (capabilities/pi.yaml) that are not `observed`,
then the axes other harnesses have and pi lacks. One probe per dispatch; the operator names it.
Open pi gaps (2026-09-09): non-observed — observability.session-identity, persistence.compaction-behavior,
extensibility.hooks-events, delegation.native-subagents, controllability.session-branching,
cross-harness.invocation-support-matrix. Missing — control.native-features-baseline, cross-harness.shell-invocation,
execution-semantics.{cron-trigger,native-agent-loop,webhook-trigger}, isolation.{global-memory-leakage,sandbox-policy},
noninteractive.structured-output-adversarial, phenotype.trojan-horse-hunter.
When the subject is pi itself: the runner spawns a separate pi in a temp dir; you read its output like any other subject's.

### provider (verified 2026-09-09)
Do NOT pass `--model` or `--provider`. Pi's own default chain lands on a working openrouter free model
(one-shot smoke replied `PI-OK`, stopReason stop). Passing `--model openrouter/free` explicitly resolves to
`z-ai/glm-5.2:free`, which OpenRouter moved off the free tier — it now 404s `unavailable for free`, and that dead
alias is why earlier reruns stalled at 0 tokens. Let pi pick. If pi reports a 404/quota, that is a provider wall:
report it verbatim as blocked, do not force a model.
