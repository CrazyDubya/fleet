# Compaction vs. Prompt Cache

**Fleet operator guide — v0.1**  
**Last reviewed:** 2026-09-09

This guide defines how Fleet should reason about prompt caching, cache lifetime, compaction, and the economic break-even between them for long-running AI agents.

The core rule is simple:

> **Caching makes repeated context cheaper to reread. Compaction makes the context itself smaller.**

They solve different problems and should normally be used together rather than treated as alternatives.

---

## 1. Mental model

A long-running agent accumulates a prompt roughly like:

```text
stable system instructions
stable tool schemas
stable repository / policy context
conversation history
recent tool results
current request
```

Prompt caching stores a reusable representation of an unchanged **prefix** of that prompt.

Compaction replaces some older conversation state with a shorter representation.

### Cache

- Reduces the price and often latency of processing unchanged prefix tokens.
- Does **not** reduce context-window occupancy.
- Does **not** make 300k tokens become 30k tokens.
- Depends heavily on prefix stability.

### Compaction

- Actually reduces the number of tokens carried forward.
- Creates a new prompt prefix, so some prior cache reuse is lost.
- Has an inference cost of its own.
- Is usually lossy unless important state is first externalized into durable files / structured state.

For Fleet, think of them as:

```text
filesystem / git / structured state = durable truth
live context                         = working memory
prompt cache                         = cheap rereading of working memory
compaction                           = lossy checkpoint of working memory
```

---

## 2. Prefix caching: why ordering matters

Prompt caches are not arbitrary token-diff caches. They primarily reuse matching prompt **prefixes**.

If the prompt is:

```text
A B C D E F G
```

and the next request is:

```text
A B C X E F G
```

then reuse can survive through `A B C`, but tokens after the first divergence no longer have the same prefix state.

Therefore:

### Good ordering

```text
stable system prompt
stable tool definitions
stable policy / repository context
append-only conversation
latest tool result
current request
```

### Bad ordering

```text
current timestamp
random request ID
changing metadata
100k of otherwise stable instructions
conversation
```

Changing something near the front can destroy reuse for a huge suffix.

**Fleet should treat sudden cache-prefix collapse during a short inter-request gap as a probable prompt-composition bug, not as ordinary TTL expiration.**

---

## 3. Claude cache economics

Anthropic currently documents two cache TTLs:

| Operation | Relative cost vs. base input | Lifetime |
|---|---:|---:|
| Normal input | 1.00x | — |
| 5-minute cache write | 1.25x | 5m |
| 1-hour cache write | 2.00x | 1h |
| Cache read / refresh | 0.10x | refreshes current TTL |

The default cache lifetime is 5 minutes. It is refreshed when the cached content is reused.

The TTL is measured from the **start of the request** that writes or reads the cache. Long generations therefore consume part of the apparent five-minute window.

Source: Anthropic Prompt Caching and Pricing documentation.

### 3.1 5m vs. 1h: the important inversion

The busiest agents usually **do not need** 1-hour caching.

If an agent invokes the model every few seconds or minutes, each cache hit keeps the 5-minute cache alive.

The 1-hour tier is most useful for agents with intermittent gaps:

- human-in-the-loop sessions
- long builds or test runs
- CI waiters
- PR reviewers
- research agents that stop for external work
- agents waiting on another agent

It is usually wasteful for:

- one-shot jobs
- fast autonomous loops
- short-lived subagents
- workloads whose pauses are normally longer than an hour

---

## 4. Claude 5m vs. 1h break-even

Let:

```text
P = cacheable prefix tokens
```

Choosing a 1h write instead of 5m adds:

```text
(2.00 - 1.25)P = 0.75P
```

If a future request occurs after the 5m entry has expired but before the 1h entry expires:

```text
5m policy: 1.25P rewrite
1h policy: 0.10P read
```

The 1h policy saves:

```text
(1.25 - 0.10)P = 1.15P
```

So for an otherwise static prefix, **one 5m–1h return can already repay the initial 1h premium**.

The reason this is not universally true for real agent sessions is that the prefix keeps growing. New tokens written under the 1h policy also pay the higher 2x write rate.

A useful generalized decision test is:

```text
use 1h when:

1.15 * M > 0.75 * W + penalty_for_>1h_misses
```

where:

- `M` = prefix tokens rescued from a 5m expiry by the 1h cache
- `W` = unique tokens written into the cache during the session

Fleet should calculate this from actual session history rather than hard-code a universal threshold.

---

## 5. Tool-call count is the wrong variable

What matters is **time between model requests**, not raw tool-call count.

Example A:

```text
50 tool calls
model invoked every 30 seconds
```

The 5m cache remains continuously hot. 1h provides little or no benefit.

Example B:

```text
1 tool call
build takes 11 minutes
next model request happens afterward
```

The 5m cache expires. A 1h entry may save a large prefix rewrite.

Fleet should therefore record:

```text
previous_model_call_at
inter_call_gap_ms
tool_calls_since_previous_model_call
tool_wall_time_ms
```

and optimize primarily on `inter_call_gap_ms`.

---

## 6. Where the 1h Claude cache loses

### One-shot work

If the prefix is written but never read:

```text
5m write = 1.25P
1h write = 2.00P
```

The 1h cache paid a 60% premium over the 5m write for no benefit.

### Tight loops

If all future requests happen within five minutes:

```text
5m: 1.25P initial write + 0.10P reads
1h: 2.00P initial write + 0.10P reads
```

The read price is the same; the extra 0.75P was wasted.

### Gaps longer than one hour

Both entries expire. The next 1h cache write costs more than the 5m rewrite and did not bridge the pause.

For workloads that usually sleep for hours, Fleet should prefer a durable checkpoint / compacted or reconstructed fresh session rather than paying repeatedly for long-TTL cache writes.

---

## 7. Mixed Claude TTLs

Anthropic permits 1h and 5m cache controls in the same request.

Important constraint:

> **Longer TTL entries must appear before shorter TTL entries.**

This allows a useful shape such as:

```text
1h: stable system + durable background
5m: rapidly growing conversation tail
uncached: current request
```

This is potentially better than selecting one TTL for the entire request.

Fleet should eventually model cache policy at the **prefix segment** level, not only the agent level.

API example:

```json
{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}
```

Observed cache accounting should be read from Anthropic response usage fields including:

```text
cache_read_input_tokens
cache_creation_input_tokens
cache_creation.ephemeral_5m_input_tokens
cache_creation.ephemeral_1h_input_tokens
```

---

## 8. OpenAI caching is not the same knob

Do not project Claude's 5m/1h policy directly onto OpenAI.

For current OpenAI GPT-5.6+ Responses API prompt caching:

- prompt caching is automatic unless configured otherwise
- the current documented minimum TTL is **30 minutes**
- OpenAI can use implicit and explicit cache breakpoints
- matching is still prefix-oriented
- cache lifetime and extended-retention behavior are provider/model dependent

Older OpenAI/Codex models can have different retention behavior. Fleet must record the exact provider + model + observed cache usage rather than assume one OpenAI-wide TTL.

OpenAI's current Responses API exposes `prompt_cache_options`; GPT-5.6+ currently documents `ttl: "30m"` as the supported minimum-TTL option.

---

## 9. Compaction: what it actually buys

Suppose a session has:

```text
P = 300,000 tokens before compaction
C = 30,000 tokens after compaction
```

Caching the 300k prefix cheaply still leaves roughly 300k tokens occupying the model's context.

Compaction changes the actual working set to roughly 30k.

That can improve:

- remaining context headroom
- future cache-write size
- future cold-start cost
- long-horizon latency
- susceptibility to context-window limits

It may also improve model focus, although that is workload dependent.

---

## 10. Compaction is not free

Compaction has at least four costs:

1. The compactor must ingest conversation/state.
2. It must generate a compact representation.
3. The new representation has to become part of a new cacheable prefix.
4. Information may be lost.

The fourth cost is frequently more important than the first three.

Before aggressive compaction, Fleet should prefer externalizing authoritative state into:

- repository files
- git commits
- structured task state
- test output summaries
- issue / PR references
- artifact manifests
- durable memory records

Then the compacted conversation can contain references to durable truth rather than trying to summarize every detail perfectly.

---

## 11. Does compaction destroy the whole cache?

Not necessarily.

If the prompt is:

```text
SYSTEM | TOOLS | POLICY | HISTORY-1...80
```

and compaction produces:

```text
SYSTEM | TOOLS | POLICY | COMPACTED-HISTORY | RECENT-TAIL
```

then the stable prefix:

```text
SYSTEM | TOOLS | POLICY
```

may remain reusable.

But from the first changed token in the compacted history onward, the previous prefix state no longer matches.

Therefore the right statement is:

> **Compaction invalidates cache reuse from the first changed portion of the prompt onward; it does not inherently invalidate an unchanged stable prefix before that point.**

This is another reason to keep stable instructions/tools at the front and conversation state later.

---

## 12. When does compaction pay back?

There is no provider-independent universal token threshold because the answer depends on:

- input price
- cache-read price
- cache-write price
- output price
- compression ratio
- whether compaction input itself receives cache reuse
- how many future turns the session survives
- whether a cache expiry would otherwise occur

Fleet should calculate break-even per event.

Define:

```text
P = pre-compaction context tokens
C = post-compaction context tokens
K = one-time compaction cost, expressed in base-input-price equivalents
r = cache-read multiplier
w = cache-write multiplier
N = future hot-cache turns
```

Approximate savings per future hot-cache turn:

```text
r * (P - C)
```

Approximate hot-cache break-even turns:

```text
N_break_even = K / (r * (P - C))
```

If compaction avoids a future cold cache rewrite, the value is much larger:

```text
avoided_cold_rewrite_value ~= w * (P - C)
```

That means compaction can be economically attractive immediately before a known idle period if it substantially reduces the prefix that would otherwise have to be rewritten later.

Fleet should never use a fixed rule such as "compact at 200k" without considering expected remaining session life.

---

## 13. Practical compaction decision policy

A reasonable initial Fleet policy is:

```text
if session is ending soon:
    do not compact merely for cost savings

elif durable state is not externalized:
    checkpoint important state first

elif expected next model request is soon and context has headroom:
    keep hot cache; do not compact unnecessarily

elif context is large and session is expected to continue many turns:
    consider compaction

elif a >TTL idle gap is expected and compaction ratio is strong:
    compact while current prefix is still hot

elif expected idle is very long:
    checkpoint + start/reconstruct a fresh session later
```

The important prediction is not only **context size**. It is:

```text
P(session continues N more turns)
```

Compacting a 300k context before one final model call can be wasteful.

Compacting the same context before another 50 calls can be highly advantageous.

---

## 14. Recommended initial TTL policy for Claude workloads

| Workload | Default policy |
|---|---|
| One-shot helper | 5m / minimal caching |
| Fast autonomous inner loop | 5m |
| Short-lived subagent | 5m |
| Interactive coding session | 1h candidate |
| Human review loop | 1h candidate |
| CI / build waiter | 1h if waits commonly exceed 5m |
| Agent waiting on another agent | 1h if gaps commonly exceed 5m |
| Continuous research loop | 5m |
| Research interrupted for human review | 1h candidate |
| Work resumed after hours | checkpoint / compact / reconstruct fresh context |

"Candidate" means Fleet should confirm that historical inter-call gaps justify the extra cache-write premium.

---

## 15. Telemetry Fleet must collect

At minimum, normalize one record per model invocation:

```text
timestamp
host_id
agent_id
parent_agent_id
session_id
turn_id
provider
model

input_fresh_tokens
cache_read_tokens
cache_write_5m_tokens
cache_write_1h_tokens
output_tokens
reasoning_tokens

context_tokens
context_limit

previous_model_call_at
inter_call_gap_ms

tool_calls_since_previous_model_call
tool_wall_time_ms

compaction_event
pre_compact_tokens
post_compact_tokens

cache_policy_requested
cache_policy_observed
```

Do not derive away the raw provider usage fields. Preserve them alongside the normalized record so future pricing/model changes can be re-evaluated historically.

---

## 16. Cache-bust detection

Fleet should classify a large cache miss into one of four categories:

```text
TTL_MISS
EXPECTED_PREFIX_MUTATION
COMPACTION_MISS
SUSPECTED_CACHE_BUST
```

A suspected cache bust looks like:

```text
short inter-call gap
+ large stable context
+ cached-token count suddenly collapses
+ no compaction / model / tool-schema / system-policy change
```

This is high-value telemetry because preventing accidental cache busts can save more than fine-tuning TTL policy.

---

## 17. Counterfactual analysis

Fleet should compute the cost of each observed session under alternative policies:

```text
actual
Claude 5m everywhere
Claude 1h everywhere
adaptive TTL
no compaction
observed compaction
alternative compaction points
fresh-session reconstruction
```

This turns cache policy into an empirical scheduling problem rather than folklore.

Useful per-agent outputs:

```text
calls <5m apart
calls 5m-1h apart
calls >1h apart
median / p90 context
cache hit rate
cache write/read ratio
estimated actual cost
estimated 5m cost
estimated 1h cost
estimated adaptive cost
compactions per session
median compression ratio
median turns-to-compaction-break-even
suspected cache bust count
```

---

## 18. Adaptive Fleet policy

Long term, `cache_policy = auto` should be deterministic and telemetry driven.

Possible inputs:

```text
current prefix size
recent inter-call distribution
expected tool duration
expected human wait
historical session survival
historical compaction ratio
prefix stability score
provider/model pricing
provider TTL capabilities
```

Possible outputs:

```text
5m
1h
provider-default
mixed TTL
compact now
checkpoint + fresh session later
```

The policy does not require an LLM. A small deterministic cost model can select the lowest expected-cost action inside provider constraints.

---

## 19. Rules of thumb

1. **Do not compact merely because a context is large.** Large + hot + actively used can be economically efficient.
2. **Do not buy 1h caching for a fast loop.** Frequent calls already refresh 5m.
3. **Do consider 1h caching for 5m–1h idle gaps.** That is its natural economic niche.
4. **Tool duration matters more than tool count.**
5. **Keep stable content first and dynamic content last.** Prefix ordering is a cost-control feature.
6. **Checkpoint durable truth before compaction.** Compaction is lossy.
7. **Compact before an expected cache expiry when the reduction is large and the session will continue.**
8. **For multi-hour sleeps, prefer reconstruction from durable state over repeatedly paying for oversized warm context.**
9. **Measure actual cache behavior.** Do not assume the requested TTL equals the observed provider behavior.
10. **Preserve raw logs.** Pricing and caching rules change; historical sessions should remain re-playable through new cost models.

---

## 20. Current provider references

- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic cost optimization: https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence
- OpenAI Responses API / prompt cache options: https://developers.openai.com/api/reference/cli/resources/responses/methods/create
- OpenAI compaction API: https://developers.openai.com/api/reference/java/resources/responses/methods/compact

Provider behavior and pricing should be treated as versioned inputs to Fleet, not constants embedded permanently in policy code.
