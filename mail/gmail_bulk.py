#!/usr/bin/env python3
"""Bulk Gmail labeler: dump inbox metadata, dry-run a rules file, apply labels in batches.

Stdlib only. Everything mutable lives under mail/data/ (gitignored).

One-time setup (the operator does this; the script never sees the Google password):
  1. console.cloud.google.com -> create/select a project -> "APIs & Services"
     -> enable "Gmail API" -> OAuth consent screen (External, test user = your address)
     -> Credentials -> Create credentials -> OAuth client ID -> Desktop app.
  2. Download the client JSON to mail/oauth_client.json.
  3. python3 mail/gmail_bulk.py auth   # opens a consent URL; approve in the browser.

Then:
  python3 mail/gmail_bulk.py dump             # inbox message metadata -> data/messages.jsonl
  python3 mail/gmail_bulk.py dryrun           # rules.json vs dump -> report, no writes
  python3 mail/gmail_bulk.py apply            # create labels + batchModify (1000 ids/call)
  python3 mail/gmail_bulk.py apply --med      # also apply confidence:"med" rules
"""

import json
import os
import re
import secrets
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
CLIENT = HERE / "oauth_client.json"
TOKEN = HERE / "token.json"
RULES = HERE / "rules.json"
DUMP = DATA / "messages.jsonl"
SCOPE = "https://www.googleapis.com/auth/gmail.modify"
API = "https://gmail.googleapis.com/gmail/v1/users/me"
BATCH = "https://gmail.googleapis.com/batch/gmail/v1"
REDIRECT_PORT = 8765
QUERY = "in:inbox"


def _client():
    blob = json.loads(CLIENT.read_text())
    key = "installed" if "installed" in blob else "web"
    return blob[key]["client_id"], blob[key]["client_secret"]


def _post_form(url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def cmd_auth():
    cid, csec = _client()
    state = secrets.token_urlsafe(16)
    redirect = f"http://localhost:{REDIRECT_PORT}/"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent", "state": state,
    })
    print("Open this URL in your browser and approve access:\n\n" + url + "\n")
    code_holder = {}

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] == state and "code" in q:
                code_holder["code"] = q["code"][0]
                body = b"Authorized. You can close this tab."
            else:
                body = b"Missing or mismatched code/state."
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", REDIRECT_PORT), H)
    while "code" not in code_holder:
        srv.handle_request()
    tok = _post_form("https://oauth2.googleapis.com/token", {
        "code": code_holder["code"], "client_id": cid, "client_secret": csec,
        "redirect_uri": redirect, "grant_type": "authorization_code"})
    tok["obtained_at"] = time.time()
    TOKEN.write_text(json.dumps(tok))
    os.chmod(TOKEN, 0o600)
    print("Token stored at", TOKEN)


def _access_token():
    tok = json.loads(TOKEN.read_text())
    if time.time() > tok.get("obtained_at", 0) + tok.get("expires_in", 0) - 120:
        cid, csec = _client()
        fresh = _post_form("https://oauth2.googleapis.com/token", {
            "refresh_token": tok["refresh_token"], "client_id": cid,
            "client_secret": csec, "grant_type": "refresh_token"})
        tok.update(fresh)
        tok["obtained_at"] = time.time()
        TOKEN.write_text(json.dumps(tok))
    return tok["access_token"]


def _get(path, tries=5):
    for i in range(tries):
        req = urllib.request.Request(API + path,
                                     headers={"Authorization": "Bearer " + _access_token()})
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and i < tries - 1:
                time.sleep(2 ** i)
                continue
            raise


def _post(path, body, tries=5):
    for i in range(tries):
        req = urllib.request.Request(API + path, data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + _access_token(),
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and i < tries - 1:
                time.sleep(2 ** i)
                continue
            raise


def _batch_metadata(ids):
    """One multipart batch request: metadata for up to 100 message ids."""
    boundary = "b" + secrets.token_hex(12)
    parts = []
    for i, mid in enumerate(ids):
        parts.append(
            f"--{boundary}\r\nContent-Type: application/http\r\n"
            f"Content-ID: <{i}>\r\n\r\n"
            f"GET /gmail/v1/users/me/messages/{mid}?format=metadata"
            f"&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Id"
            f"&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=List-Unsubscribe"
            f"&metadataHeaders=Precedence\r\n\r\n")
    payload = ("".join(parts) + f"--{boundary}--\r\n").encode()
    req = urllib.request.Request(
        BATCH, data=payload,
        headers={"Authorization": "Bearer " + _access_token(),
                 "Content-Type": f"multipart/mixed; boundary={boundary}"})
    with urllib.request.urlopen(req) as r:
        body = r.read().decode("utf-8", "replace")
    out = []
    for chunk in body.split("--")[1:-1]:
        start = chunk.find("{")
        if start == -1:
            continue
        depth = 0
        for j, ch in enumerate(chunk[start:], start):
            depth += ch == "{"
            depth -= ch == "}"
            if depth == 0:
                try:
                    out.append(json.loads(chunk[start:j + 1]))
                except json.JSONDecodeError:
                    pass
                break
    return out


def _row(msg):
    h = {x["name"].lower(): x["value"] for x in msg.get("payload", {}).get("headers", [])}
    return {"id": msg["id"], "threadId": msg.get("threadId"),
            "labelIds": msg.get("labelIds", []), "date": msg.get("internalDate"),
            "from": h.get("from", ""), "to": h.get("to", "") + " " + h.get("cc", ""),
            "subject": h.get("subject", ""), "list_id": h.get("list-id", ""),
            "list_unsub": "list-unsubscribe" in h, "precedence": h.get("precedence", "")}


def cmd_dump():
    DATA.mkdir(exist_ok=True)
    done = set()
    if DUMP.exists():
        with DUMP.open() as f:
            done = {json.loads(l)["id"] for l in f if l.strip()}
        print(f"resuming: {len(done)} already dumped")
    ids, token = [], None
    while True:
        q = f"/messages?q={urllib.parse.quote(QUERY)}&maxResults=500"
        page = _get(q + (f"&pageToken={token}" if token else ""))
        ids += [m["id"] for m in page.get("messages", [])]
        token = page.get("nextPageToken")
        print(f"\rlisted {len(ids)}", end="", flush=True)
        if not token:
            break
    todo = [i for i in ids if i not in done]
    print(f"\ntotal {len(ids)}, fetching metadata for {len(todo)}")
    with DUMP.open("a") as f:
        for k in range(0, len(todo), 100):
            for msg in _batch_metadata(todo[k:k + 100]):
                if "id" in msg:
                    f.write(json.dumps(_row(msg)) + "\n")
            print(f"\rfetched {min(k + 100, len(todo))}/{len(todo)}", end="", flush=True)
    print("\ndump ->", DUMP)


def _addr(from_header):
    m = re.search(r"<([^>]+)>", from_header)
    a = (m.group(1) if m else from_header).strip().lower()
    return a


def _match(rule, row):
    m = rule["match"]
    a = _addr(row["from"])
    dom = a.split("@")[-1]
    if "from_addr" in m and a != m["from_addr"].lower():
        return False
    if "from_domain" in m:
        want = m["from_domain"].lower()
        if not (dom == want or dom.endswith("." + want)):
            return False
    if "to_addr_re" in m and not re.search(m["to_addr_re"], row["to"], re.I):
        return False
    if "subject_re" in m and not re.search(m["subject_re"], row["subject"], re.I):
        return False
    if "list_id" in m and m["list_id"].lower() not in row["list_id"].lower():
        return False
    return True


def _load_rules_doc():
    doc = json.loads(RULES.read_text())
    if isinstance(doc, list):
        doc = {"rules": doc, "reserved_labels": []}
    reserved = doc.get("reserved_labels", [])
    for r in doc["rules"]:
        for res in reserved:
            pat = "^" + re.escape(res).replace(r"\*", ".*") + "$"
            if re.match(pat, r["label"]):
                sys.exit(f"refusing to run: rule {r.get('id')} writes reserved label {r['label']}")
    return doc


def _guarded(row, guards):
    """True = personal-mail guard trips: skip every rule, send to review (spec 2.4)."""
    g = guards.get("skip_all_rules_if")
    if not g:
        return False
    if row.get("list_unsub") or row.get("list_id"):
        return False
    if row.get("precedence", "").lower() in [p.lower() for p in g.get("not_precedence", [])]:
        return False
    dom = _addr(row["from"]).split("@")[-1]
    return dom in g.get("from_domain_in", [])


def _classify(rows, include_med):
    doc = _load_rules_doc()
    rules = doc["rules"]
    if not include_med:
        rules = [r for r in rules if r.get("confidence", "high") == "high"]
    guards = doc.get("guards", {})
    by_rule, unmatched, guarded = {}, [], []
    for row in rows:
        if _guarded(row, guards):
            guarded.append(row)
            continue
        for rule in rules:
            if _match(rule, row):
                by_rule.setdefault(rule["id"], []).append(row)
                break
        else:
            unmatched.append(row)
    meta = {r["id"]: r for r in rules}
    return by_rule, meta, unmatched, guarded


def _load_rows():
    with DUMP.open() as f:
        return [json.loads(l) for l in f if l.strip()]


def cmd_dryrun(include_med):
    import random
    rows = _load_rows()
    by_rule, meta, unmatched, guarded = _classify(rows, include_med)
    lines = [f"# dry run - {len(rows)} messages, med rules {'ON' if include_med else 'off'}", ""]
    lines.append("## Per rule (validation §5: read the samples for every rule over 50 hits)\n")
    for rid in sorted(by_rule, key=lambda r: -len(by_rule[r])):
        rs, m = by_rule[rid], meta[rid]
        lines.append(f"### {rid} -> {m['label']}  [{len(rs)} hits, "
                     f"{m.get('confidence','high')}/{m.get('source','?')}]")
        if len(rs) > 50:
            for r in random.sample(rs, 20):
                lines.append(f"  - {_addr(r['from'])} | {r['subject'][:90]}")
        else:
            for r in rs[:8]:
                lines.append(f"  - {_addr(r['from'])} | {r['subject'][:90]}")
    lines.append(f"\n## GUARDED as likely-personal (review, spec 2.4): {len(guarded)}")
    for r in guarded[:30]:
        lines.append(f"  - {_addr(r['from'])} | {r['subject'][:90]}")
    lines.append(f"\n## UNMATCHED (review): {len(unmatched)} - by sender domain, desc")
    doms = {}
    for r in unmatched:
        doms[_addr(r["from"]).split("@")[-1]] = doms.get(_addr(r["from"]).split("@")[-1], 0) + 1
    for d, n in sorted(doms.items(), key=lambda x: -x[1])[:60]:
        lines.append(f"  - {d}: {n}" + ("   << add a rule (spec §5.2)" if n > 100 else ""))
    report = "\n".join(lines)
    (DATA / "dryrun.md").write_text(report + "\n")
    labeled = sum(len(v) for v in by_rule.values())
    print(f"labeled {labeled} / guarded {len(guarded)} / unmatched {len(unmatched)}"
          f" -> full report: {DATA/'dryrun.md'}")


def _ensure_labels(names):
    existing = {l["name"]: l["id"] for l in _get("/labels")["labels"]}
    out = {}
    for name in names:
        if name not in existing:
            made = _post("/labels", {"name": name, "labelListVisibility": "labelShow",
                                     "messageListVisibility": "show"})
            existing[name] = made["id"]
            print("created label", name)
        out[name] = existing[name]
    return out


def cmd_apply(include_med, only_rule=None):
    rows = _load_rows()
    by_rule, meta, unmatched, guarded = _classify(rows, include_med)
    if only_rule:
        by_rule = {k: v for k, v in by_rule.items() if k == only_rule}
        if not by_rule:
            sys.exit(f"rule {only_rule} matched nothing (or does not exist)")
    label_ids = _ensure_labels(sorted({meta[r]["label"] for r in by_rule}))
    total = 0
    applied = json.loads((DATA / "applied.json").read_text()) if (DATA / "applied.json").exists() else {}
    for rid, rs in by_rule.items():
        ids = [r["id"] for r in rs if r["id"] not in applied.get(rid, [])]
        for k in range(0, len(ids), 1000):
            _post("/messages/batchModify",
                  {"ids": ids[k:k + 1000], "addLabelIds": [label_ids[meta[rid]["label"]]]})
            total += len(ids[k:k + 1000])
            print(f"\r{rid}: labeled {total} total", end="", flush=True)
        applied.setdefault(rid, []).extend(ids)
        (DATA / "applied.json").write_text(json.dumps(applied))
    print(f"\ndone: {total} labeled via {len(by_rule)} rules; "
          f"{len(guarded)} guarded + {len(unmatched)} unmatched left for review")


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "help"
    med = "--med" in args
    if cmd == "auth":
        cmd_auth()
    elif cmd == "dump":
        cmd_dump()
    elif cmd == "dryrun":
        cmd_dryrun(med)
    elif cmd == "apply":
        only = next((a.split("=", 1)[1] for a in args if a.startswith("--rule=")), None)
        cmd_apply(med, only)
    else:
        print(__doc__)
