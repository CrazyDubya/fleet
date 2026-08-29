"""Aggregate runs.jsonl (spec: Report)."""
import json
import statistics as st
from pathlib import Path

ARMS = ("fable", "sonnet", "fleet")


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


def _arm_stats(rows: list[dict]) -> dict:
    passes = [r for r in rows if r["status"] == "pass"]
    judged = [r for r in rows if r.get("judge") is not None]
    return {"n": len(rows), "pass_rate": (len(passes) / len(rows)) if rows else None,
            # the judge is the bench's own opus spend, reported beside `usd`, never inside it
            "judge_usd_med": _med([r.get("judge_usd") for r in judged]),
            "profiles": sorted({r.get("profile") for r in rows if r.get("profile")}),
            "claude_versions": sorted({r.get("claude_version") for r in rows if r.get("claude_version")}),
            "wall_med": _med([r["wall_s"] for r in rows]), "usd_med": _med([r["usd"] for r in rows]),
            "weekly_med": _med([sum(r["pool"]["weekly"].values()) for r in rows]), "fable_med": _med([r["pool"]["fable"] for r in rows]),
            "interventions_per_run": (sum(sum(r["interventions"].values()) for r in rows) / len(rows)) if rows else None,
            "judge_med": _med([r["judge"] for r in passes]),
            # per-pass medians feed the headline ratios
            "_wall_pass_med": _med([r["wall_s"] for r in passes]), "_usd_pass_med": _med([r["usd"] for r in passes]),
            "_weekly_pass_med": _med([sum(r["pool"]["weekly"].values()) for r in passes])}


def _ratio(a, b):
    return round(a / b, 4) if a is not None and b else None


def summarize(rows: list[dict]) -> dict:
    out: dict = {}
    for r in rows:
        out.setdefault(r["task"], {}).setdefault(r["arm"], []).append(r)
    summary = {task: {arm: _arm_stats(rs) for arm, rs in arms.items()} for task, arms in out.items()}
    by_arm = {arm: [r for r in rows if r["arm"] == arm] for arm in ARMS}
    stats = {arm: _arm_stats(rs) for arm, rs in by_arm.items()}
    acc = {arm: stats[arm]["pass_rate"] for arm in ARMS}
    cost = {arm: stats[arm]["_usd_pass_med"] for arm in ARMS}
    weekly = {arm: stats[arm]["_weekly_pass_med"] for arm in ARMS}
    tm = {arm: stats[arm]["_wall_pass_med"] for arm in ARMS}
    summary["headline"] = {
        "n": {arm: stats[arm]["n"] for arm in ARMS},
        "accuracy": {**acc, "fleet_vs_sonnet": _ratio(acc["fleet"], acc["sonnet"]), "fleet_vs_fable": _ratio(acc["fleet"], acc["fable"])},
        "cost": {**cost, "weekly": weekly, "fleet_vs_sonnet": _ratio(cost["fleet"], cost["sonnet"]), "fleet_vs_fable": _ratio(cost["fleet"], cost["fable"])},
        "time": {**tm, "fleet_vs_sonnet": _ratio(tm["fleet"], tm["sonnet"]), "fleet_vs_fable": _ratio(tm["fleet"], tm["fable"])},
    }
    return summary


def _f(x, fmt="{:.2f}"):
    return "-" if x is None else fmt.format(x)


def _spanned(summary: dict) -> tuple[list[str], list[str]]:
    """Distinct profiles / claude versions across every arm - rows that disagree are not
    directly comparable, so the table has to say so rather than quietly average them."""
    profiles: set[str] = set(); versions: set[str] = set()
    for task, arms in summary.items():
        if task == "headline":
            continue
        for s in arms.values():
            profiles |= set(s.get("profiles") or []); versions |= set(s.get("claude_versions") or [])
    return sorted(profiles), sorted(versions)


def render(summary: dict) -> str:
    profiles, versions = _spanned(summary)
    mixed = len(profiles) > 1 or len(versions) > 1
    lines = []
    if mixed:
        lines.append(f"warning: rows span {len(versions)} claude versions / {len(profiles)} profiles - the arms are not like for like")
    head = f"{'task':16} {'arm':7} {'n':>3} {'pass':>5} {'wall':>7} {'$':>6} {'judge$':>7} {'weekly$':>8} {'fable$':>7} {'interv':>6} {'judge':>5}"
    lines.append(head + (f" {'profile':>8} {'claude':>14}" if mixed else ""))
    for task, arms in summary.items():
        if task == "headline":
            continue
        for arm, s in arms.items():
            row = (f"{task:16} {arm:7} {s['n']:>3} {_f(s['pass_rate']):>5} {_f(s['wall_med'], '{:.0f}s'):>7} {_f(s['usd_med']):>6} "
                   f"{_f(s.get('judge_usd_med')):>7} {_f(s['weekly_med']):>8} {_f(s['fable_med']):>7} "
                   f"{_f(s['interventions_per_run'], '{:.1f}'):>6} {_f(s['judge_med'], '{:.1f}'):>5}")
            if mixed:
                row += f" {','.join(s.get('profiles') or ['-']):>8} {','.join(s.get('claude_versions') or ['-']):>14}"
            lines.append(row)
    h = summary.get("headline", {})
    if h:
        n = h["n"]
        lines.append("")
        lines.append(f"accuracy (pass rate)  fable {_f(h['accuracy']['fable'])} n={n['fable']}  sonnet {_f(h['accuracy']['sonnet'])} n={n['sonnet']}  "
                     f"fleet {_f(h['accuracy']['fleet'])} n={n['fleet']}  | fleet/sonnet {_f(h['accuracy']['fleet_vs_sonnet'])}  fleet/fable {_f(h['accuracy']['fleet_vs_fable'])}")
        lines.append(f"cost ($ per pass)     fable {_f(h['cost']['fable'])}  sonnet {_f(h['cost']['sonnet'])}  fleet {_f(h['cost']['fleet'])}  "
                     f"(weekly-pool $: sonnet {_f(h['cost']['weekly']['sonnet'])}  fleet {_f(h['cost']['weekly']['fleet'])})  | fleet/sonnet {_f(h['cost']['fleet_vs_sonnet'])}  fleet/fable {_f(h['cost']['fleet_vs_fable'])}")
        lines.append(f"time (s per pass)     fable {_f(h['time']['fable'], '{:.0f}')}  sonnet {_f(h['time']['sonnet'], '{:.0f}')}  fleet {_f(h['time']['fleet'], '{:.0f}')}  "
                     f"| fleet/sonnet {_f(h['time']['fleet_vs_sonnet'])}  fleet/fable {_f(h['time']['fleet_vs_fable'])}")
    return "\n".join(lines)
