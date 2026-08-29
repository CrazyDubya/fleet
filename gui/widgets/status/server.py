"""Live `fleet status`, as JSON."""
from dataclasses import asdict

from fleet import status

WATCH = ["state/registry.json"]


def get(ctx):
    return {"rows": [asdict(r) for r in status.rows()]}


ROUTES = {"": get}
