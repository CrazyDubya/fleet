"""Aggregate runs.jsonl (spec: Report)."""
import json
import statistics as st
from pathlib import Path

ARMS = ("fable", "sonnet", "fleet", "haiku-swarm", "sonnet-swarm")
NOT_A_TASK = ("headline", "cache")  # reserved top-level keys in a summary


def load(path: Path, since: float | None = None) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines() if path.exists() else []:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if since is None or (r.get("t0") or 0) >= since:
            rows.append(r)
    return rows


def _med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs), 4) if xs else None


NON_ATTEMPT = ("skipped",)


def attempted(rows: list[dict]) -> list[dict]:
    """Rows where the arm actually took a run at the task.

    A pass rate is a claim about the arm, so its denominator may only hold runs
    the arm attempted. Three things end a run before the arm ever sees the task:
    the collision guard declining to send, the CLI refusing its own invocation,
    and task setup failing (missing ref / expect). Counting any of them as a
    failure measures our harness, not the arm - which is how 11 runs where
    `claude -p` exited at startup on an inert Write() rule were reported as
    sonnet failing 11 tasks, and how `fleet/sonnet 3.00` came to mean
    "fleet beat a process that never ran".

    Non-attempts stay in `n` and get their own column, exactly as a
    `measured: false` row stays in `n` but out of the medians."""
    return [r for r in rows if r.get("status") not in NON_ATTEMPT]


def measured(rows: list[dict]) -> list[dict]:
    """Rows whose cost/token window is real. A row with `measured: false` reports $0 by
    accident, not by fact, so it must not drag a median down; it still counts in `n`.
    Rows written before the flag existed have no key and are taken at face value."""
    return [r for r in rows if r.get("measured", True)]


def _arm_stats(rows: list[dict]) -> dict:
    att = attempted(rows)
    passes = [r for r in att if r["status"] == "pass"]
    m = measured(rows)
    return {"n": len(rows), "errors": sum(1 for r in rows if r["status"] == "error"),
            "attempts": len(att), "skipped": len(rows) - len(att),
            # denominator is attempts, not rows: see attempted()
            "pass_rate": (len(passes) / len(att)) if att else None,
            # the judge is the bench's own opus spend, reported beside `usd`, never inside it.
            # Keyed off a recorded judge_usd, not off `judge`: a judge whose score would not
            # parse still spent. Rows with no cost recorded (0.0 / absent - no judge ran) are
            # left out, or the median of a half-judged arm drifts toward zero and means nothing.
            "judge_usd_med": _med([r["judge_usd"] for r in m if r.get("judge_usd")]),
            "profiles": sorted({r.get("profile") or "?" for r in rows}),
            "claude_versions": sorted({r.get("claude_version") or "?" for r in rows}),
            "wall_med": _med([r["wall_s"] for r in rows]), "usd_med": _med([r["usd"] for r in m]),
            "weekly_med": _med([sum(r["pool"]["weekly"].values()) for r in m]), "fable_med": _med([r["pool"]["fable"] for r in m]),
            "interventions_per_run": (sum(sum(r["interventions"].values()) for r in m) / len(m)) if m else None,
            "judge_med": _med([r["judge"] for r in passes])}


def cache_by_model(rows: list[dict]) -> dict:
    """Per (arm, model) prompt-token split, over MEASURED rows only.

    `tokens_by_model` has recorded cache_read/cache_write per model since the
    first run; nothing ever reported it. Hit rate is the share of prompt tokens
    served from cache - input + cache_read + cache_write is the whole prompt, so
    the three shares sum to 1 and a high write% with a low hit% is cache being
    paid for and not reused."""
    out: dict[tuple[str, str], dict] = {}
    for r in attempted(measured(rows)):  # a run the arm never took has no cache behaviour
        for m, t in (r.get("tokens") or {}).items():
            a = out.setdefault((r["arm"], m), {"runs": 0, "input": 0, "cache_read": 0, "cache_write": 0, "output": 0})
            a["runs"] += 1
            for k in ("input", "cache_read", "cache_write", "output"):
                a[k] += t.get(k, 0)
    for a in out.values():
        prompt = a["input"] + a["cache_read"] + a["cache_write"]
        a["prompt"] = prompt
        a["hit"] = (a["cache_read"] / prompt) if prompt else None
        a["write_share"] = (a["cache_write"] / prompt) if prompt else None
        a["miss_share"] = (a["input"] / prompt) if prompt else None
    # a model with no prompt tokens says nothing and only pads the table
    return {f"{arm}\t{model}": v for (arm, model), v in sorted(out.items()) if v["prompt"]}


def _ratio(a, b):
    return round(a / b, 4) if a is not None and b else None


def _pass_meds(rows: list[dict]) -> dict:
    """Per-pass medians behind the headline ratios - local to the summary, never part of a
    per-arm stats dict a widget might render."""
    passes = [r for r in attempted(rows) if r["status"] == "pass"]
    priced = measured(passes)  # a $0 unmeasured pass is not a cost sample
    return {"wall": _med([r["wall_s"] for r in passes]), "usd": _med([r["usd"] for r in priced]),
            "weekly": _med([sum(r["pool"]["weekly"].values()) for r in priced])}


def summarize(rows: list[dict]) -> dict:
    out: dict = {}
    for r in rows:
        out.setdefault(r["task"], {}).setdefault(r["arm"], []).append(r)
    summary = {task: {arm: _arm_stats(rs) for arm, rs in arms.items()} for task, arms in out.items()}
    by_arm = {arm: [r for r in rows if r["arm"] == arm] for arm in ARMS}
    stats = {arm: _arm_stats(rs) for arm, rs in by_arm.items()}
    pm = {arm: _pass_meds(rs) for arm, rs in by_arm.items()}
    acc = {arm: stats[arm]["pass_rate"] for arm in ARMS}
    cost = {arm: pm[arm]["usd"] for arm in ARMS}
    weekly = {arm: pm[arm]["weekly"] for arm in ARMS}
    tm = {arm: pm[arm]["wall"] for arm in ARMS}
    summary["cache"] = cache_by_model(rows)
    summary["headline"] = {
        # the n printed beside a pass rate is that rate's denominator - attempts,
        # not rows - or the reader divides by the wrong number.
        "n": {arm: stats[arm]["attempts"] for arm in ARMS},
        "runs": {arm: stats[arm]["n"] for arm in ARMS},
        "skipped": {arm: stats[arm]["skipped"] for arm in ARMS},
        "accuracy": {**acc, "fleet_vs_sonnet": _ratio(acc["fleet"], acc["sonnet"]), "fleet_vs_fable": _ratio(acc["fleet"], acc["fable"])},
        "cost": {**cost, "weekly": weekly, "fleet_vs_sonnet": _ratio(cost["fleet"], cost["sonnet"]), "fleet_vs_fable": _ratio(cost["fleet"], cost["fable"])},
        "time": {**tm, "fleet_vs_sonnet": _ratio(tm["fleet"], tm["sonnet"]), "fleet_vs_fable": _ratio(tm["fleet"], tm["fable"])},
    }
    return summary


def _f(x, fmt="{:.2f}"):
    return "-" if x is None else fmt.format(x)


def _spanned(summary: dict) -> tuple[list[str], list[str]]:
    """Distinct profiles / claude versions across every arm - rows that disagree are not
    directly comparable, so the table has to say so rather than quietly average them.

    An unlabelled row counts as the distinct value "?", so a pre-provenance row mixed in
    with labelled ones is exactly the case the warning exists for."""
    profiles: set[str] = set(); versions: set[str] = set()
    for task, arms in summary.items():
        if task in NOT_A_TASK:
            continue
        for s in arms.values():
            profiles |= set(s.get("profiles") or []); versions |= set(s.get("claude_versions") or [])
    return sorted(profiles), sorted(versions)


def stats_of(summary: dict, arm: str) -> dict | None:
    """Flat per-arm headline numbers, or None if the arm never ran."""
    h = summary.get("headline") or {}
    n = (h.get("n") or {}).get(arm) or 0
    runs = (h.get("runs") or {}).get(arm) or 0
    if not runs:
        return None
    return {"n": n, "skip": (h.get("skipped") or {}).get(arm) or 0,
            "pass": (h.get("accuracy") or {}).get(arm),
            "time": (h.get("time") or {}).get(arm),
            "usd": (h.get("cost") or {}).get(arm)}


def render(summary: dict) -> str:
    profiles, versions = _spanned(summary)
    mixed = len(profiles) > 1 or len(versions) > 1
    lines = []
    if mixed:
        lines.append(f"warning: rows span {len(versions)} claude versions / {len(profiles)} profiles - the arms are not like for like")
    w = max([len("task")] + [len(t) for t in summary if t not in NOT_A_TASK])  # ids longer than 16 chars must not shove the columns
    head = f"{'task':{w}} {'arm':7} {'n':>3} {'err':>3} {'skip':>4} {'pass':>5} {'wall':>7} {'$':>6} {'judge$':>7} {'weekly$':>8} {'fable$':>7} {'interv':>6} {'judge':>5}"
    lines.append(head + (f" {'profile':>8} {'claude':>14}" if mixed else ""))
    for task, arms in summary.items():
        if task in NOT_A_TASK:
            continue
        for arm, s in arms.items():
            row = (f"{task:{w}} {arm:7} {s['n']:>3} {s.get('errors', 0):>3} {s.get('skipped', 0):>4} {_f(s['pass_rate']):>5} {_f(s['wall_med'], '{:.0f}s'):>7} {_f(s['usd_med']):>6} "
                   f"{_f(s.get('judge_usd_med')):>7} {_f(s['weekly_med']):>8} {_f(s['fable_med']):>7} "
                   f"{_f(s['interventions_per_run'], '{:.1f}'):>6} {_f(s['judge_med'], '{:.1f}'):>5}")
            if mixed:
                row += f" {','.join(s.get('profiles') or ['-']):>8} {','.join(s.get('claude_versions') or ['-']):>14}"
            lines.append(row)
    h = summary.get("headline", {})
    if h:
        n = h["n"]
        lines.append("")
        sk = h.get("skipped", {})

        def _n(arm):  # n is attempts; say so when rows were dropped, or 2 of 13 reads as a typo
            s_ = sk.get(arm) or 0
            return f"n={n[arm]}" + (f"(+{s_} skip)" if s_ else "")

        # One row per arm that actually ran. The three-arm hardcoded summary could
        # not show a swarm at all, and time-to-completion is the metric the bench
        # exists for, so it leads.
        lines.append("")
        lines.append(f"{'arm':13} {'n':>4} {'skip':>5} {'pass':>6} {'s/pass':>8} {'$/pass':>8}")
        for arm in ARMS:
            if not stats_of(summary, arm):
                continue
            st = stats_of(summary, arm)
            lines.append(f"{arm:13} {st['n']:>4} {st['skip']:>5} {_f(st['pass']):>6} "
                         f"{_f(st['time'], '{:.0f}'):>8} {_f(st['usd']):>8}")
        base = "sonnet"
        lines.append("")
        for arm in ARMS:
            st = stats_of(summary, arm)
            bs = stats_of(summary, base)
            if arm == base or not st or not bs:
                continue
            lines.append(f"  {arm} vs {base}:  time {_f(_ratio(st['time'], bs['time']))}x  "
                         f"accuracy {_f(_ratio(st['pass'], bs['pass']))}x  cost {_f(_ratio(st['usd'], bs['usd']))}x")
    c = summary.get("cache") or {}
    if c:
        lines.append("")
        lines.append("cache by model (share of prompt tokens; hit+write+miss = 1)")
        mw = max(len(k.split("\t")[1]) for k in c)
        lines.append(f"{'arm':7} {'model':{mw}} {'runs':>4} {'prompt':>10} {'hit%':>6} {'write%':>7} {'miss%':>6} {'out':>8}")
        for k, v in c.items():
            arm, model = k.split("\t")
            lines.append(f"{arm:7} {model:{mw}} {v['runs']:>4} {v['prompt']:>10,} "
                         f"{_f(v['hit'] and v['hit'] * 100, '{:.1f}'):>6} {_f(v['write_share'] and v['write_share'] * 100, '{:.1f}'):>7} "
                         f"{_f(v['miss_share'] and v['miss_share'] * 100, '{:.1f}'):>6} {v['output']:>8,}")
    return "\n".join(lines)
