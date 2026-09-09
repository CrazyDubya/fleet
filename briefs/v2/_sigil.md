## Sigil grammar v1 — packet bodies (any thread; operator ↔ Fleet ∅)

The packet header from `_protocol.md` is unchanged and still parsed by tools. This grammar
replaces the *body*. One sigil per line, slots in this order, empty slots omitted.

    >   do        > run e3 with E_WALL=0.45
    ?   ask       ? 1) owner sonnet2|sonnet3  2) respawn y|n     (numbered; answer with =)
    =   answer    = 1a 2n
    !   must-know ! spec_hash drift on 9 threads
    ✓   done      ✓ e3 rerun → 6c11ed7 · 260/0 tests               (✓ REQUIRES a →)
    ✗   blocked   ✗ perm · curl denied
    ~   partial   ~ sweep 3/8 surfaces
    #   fact      # 1081 send · 1 reply · 26 open
    →   at        → ledger/handoffs/opus2/…-fleet-reflection.md
    $   cost      $ 12k tok · est$0.04
    >>  verbose   >> explain the perm hook       (prose allowed for this packet only)

Field separator inside a line: ` · `. Progress: `n/m`. Options: `a|b|c`, `y|n`.

Rules
1. Canonical thread names, never abbreviated. `opus2`, not `o2`.
2. Numbers, not adjectives. `# 79% silent/7d`, not "mostly idle".
3. Paths, hashes, test counts — not paste. A `✓` without a `→` is not done; it is a claim.
4. No restating the ask, no rationale, no next-steps. A next step is a `?`.
5. Prose only under `>>`. If it needs a paragraph it needs a handoff file; send `→`.
6. To a haiku relay: `>` lines only, at most three, imperative. They act on orders and
   re-plan on explanations (measured n=5).
7. A claim about another thread's state is `#` only if you sampled it this turn; otherwise
   write `~ not attempted this session`.

Why: a review of the overseer's first three turns found ~800 words carrying ~100 words of
information (narrate → restate → justify → caveat → offer). The fleet's largest avoidable cost
is prose, and the cache-friendliest packet is one whose shape never changes.
