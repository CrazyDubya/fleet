"""Typed packets (spec §1): 3-line header + body. Compress coordination, never content."""
import re
import secrets
import time
from dataclasses import dataclass, field

EFFORTS = {"low": "low", "med": "medium", "medium": "medium", "high": "high"}
FIELD_RE = re.compile(r"@([a-z]+)\s+(.*?)(?=\s+@[a-z]+\s|$)")


@dataclass
class Lane:
    target: str
    effort: str
    tier: str
    reply: str


LANES: dict[str, Lane] = {
    "lookup": Lane("haiku-fs2", "low", "tool", "inline"),
    "build": Lane("sonnet2", "med", "hot", "file"),
    "plan": Lane("opus2", "high", "warm", "file"),
    "judge": Lane("judge", "med", "tool", "file"),
    "consult": Lane("fable", "high", "warm", "file"),
}


@dataclass
class Packet:
    to: str
    sender: str
    lane: str
    effort: str
    reply: str
    refs: list[str] = field(default_factory=list)
    done: str | None = None
    id: str | None = None
    body: str = ""


@dataclass
class Reply:
    sender: str
    re: str
    status: str
    out: str | None = None
    body: str = ""


def normalize_effort(s: str) -> str:
    try:
        return EFFORTS[s]
    except KeyError:
        raise ValueError(f"effort must be one of {sorted(EFFORTS)}, not {s!r}")


def new_id() -> str:
    # time-prefixed so ids sort by creation; 16 chars, hex, no ambiguity in shell
    return f"{int(time.time() * 1000):011x}"[-10:] + secrets.token_hex(3)


def _fields(line: str) -> dict[str, str]:
    return {k: v.strip() for k, v in FIELD_RE.findall(line)}


def parse(text: str):
    lines = text.split("\n")
    if not lines or not lines[0].startswith("@"):
        return None
    head = _fields(lines[0])
    i = 1
    refs: list[str] = []
    done = None
    while i < len(lines) and lines[i].startswith("@"):
        f = _fields(lines[i])
        if "refs" in f:
            refs = f["refs"].split()
        if "done" in f:
            done = f["done"]
        i += 1
    body = "\n".join(lines[i:])
    if "re" in head:
        return Reply(sender=head.get("from", ""), re=head["re"], status=head.get("status", ""),
                     out=head.get("out"), body=body)
    if "to" not in head:
        return None
    lane = head.get("lane", "build")
    ln = LANES.get(lane, LANES["build"])
    return Packet(to=head["to"], sender=head.get("from", "operator"), lane=lane,
                  effort=head.get("effort", ln.effort), reply=head.get("reply", ln.reply),
                  refs=refs, done=done, id=head.get("id"), body=body)


def format_packet(p: Packet) -> str:
    head = f"@to {p.to}  @from {p.sender}  @lane {p.lane}  @effort {p.effort}  @reply {p.reply}"
    if p.id:
        head += f"  @id {p.id}"
    lines = [head]
    if p.refs:
        lines.append("@refs " + " ".join(p.refs))
    if p.done:
        lines.append(f"@done {p.done}")
    return "\n".join(lines) + "\n" + p.body


def format_reply(r: Reply) -> str:
    head = f"@from {r.sender}  @re {r.re}  @status {r.status}"
    if r.out:
        head += f"  @out {r.out}"
    return head + "\n" + r.body
