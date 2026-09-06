"""Typed packets (spec §1): 3-line header + body. Compress coordination, never content."""
import re
import secrets
import time
from dataclasses import dataclass, field

EFFORTS = {"low": "low", "med": "medium", "medium": "medium", "high": "high"}
FIELD_RE = re.compile(r"@([a-z]+)\s+(.*?)(?=\s+@[a-z]+\s|$)")
# Whitespace AND markdown emphasis, because both sit between an @-header and its
# value in text we have to match against.
_MARKUP_RE = re.compile(r"[\s*_`~]+")


def norm(s: str) -> str:
    """Whitespace- and markdown-insensitive form, for locating `@re<id>` in prose.

    A thread answering a packet writes a handoff in this repo's house style:

        - **@from** sonnet2 · **@re** 1a06611465c9bf6a · **status** done

    Stripping only whitespace leaves `**@re**1a066...`, so a search for the
    literal `@re<id>` misses a correct reply. That cost 2 of the fleet arm's 9
    bench timeouts outright - one handoff landed 2 minutes into a 15-minute
    window and the detector waited out the other 13 - and every such run was
    then scored as the fleet failing the task.

    Ids are 16 hex chars, so collapsing emphasis cannot merge two distinct ids.
    """
    return _MARKUP_RE.sub("", s)


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
        # `from None`: the KeyError is an implementation detail, and chaining it
        # buries the actual message under "During handling of the above...".
        raise ValueError(f"effort must be one of {sorted(EFFORTS)}, not {s!r}") from None


def new_id() -> str:
    """16 hex chars: 11 for the millisecond clock, 5 random.

    Time-prefixed so ids sort by creation - which only worked by accident
    before: the prefix was truncated to its LAST 10 hex digits, so every id
    minted either side of a carry into the 11th digit sorted backwards
    (16^10 ms is ~34 days, so the boundary comes round monthly). Keep all 11
    digits and take the width back out of the random tail; 20 bits of
    randomness within a single millisecond is still ~1e-6 collision odds for
    a fleet that never mints two ids in the same ms anyway.
    """
    return f"{int(time.time() * 1000):011x}{secrets.randbits(20):05x}"


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
    try:
        # A MISSING @lane defaults to build (the header is 3 lines and a
        # sender may leave it off). An UNKNOWN one is a typo - silently
        # routing "@lane plann" as a build packet sent it to the wrong thread
        # at the wrong effort with nothing in the log to say so.
        ln = LANES[lane]
    except KeyError:
        raise ValueError(f"unknown lane {lane!r}; expected one of {sorted(LANES)}") from None
    return Packet(to=head["to"], sender=head.get("from", "operator"), lane=lane,
                  effort=head.get("effort", ln.effort), reply=head.get("reply", ln.reply),
                  refs=refs, done=done, id=head.get("id"), body=body)


LEDGER_FIELDS = ("id", "lane", "effort", "reply", "done")


def extract_ledger_fields(text: str) -> dict[str, str]:
    """Best-effort @id/@lane/@effort/@reply/@done extraction for ledger logging,
    tolerant of headers `parse()` would reject (unknown lane, non-hex id, a
    freeform @reply value like "handoff").

    Only a packet built by `send_packet()` was logged with these fields -
    `send()` pastes raw text as-is, including a hand-typed packet a sender
    composed themselves rather than going through --lane/--effort/--reply.
    That left the ledger with bytes and a hash and no id at all for such a
    dispatch, breaking the send/reply join for exactly the packets a human
    is most likely to have typed carelessly.
    """
    lines = text.split("\n")
    if not lines or not lines[0].startswith("@"):
        return {}
    out: dict[str, str] = {}
    i = 0
    while i < len(lines) and lines[i].startswith("@"):
        f = _fields(lines[i])
        for k in LEDGER_FIELDS:
            if k in f and k not in out:
                out[k] = f[k]
        i += 1
    return out


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
