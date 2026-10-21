"""Minimal client for the agentic-browser HTTP API (start it with `npm run http`).

Uses only the standard library. The API always requires a Bearer token: AGENT_TOKEN if you
set it, otherwise the one the server writes to ~/.agentic-browser/http-token on first start.
"""
import json
import os
import pathlib
import urllib.request

BASE = os.environ.get("AGENT_URL", "http://127.0.0.1:8787")
TOKEN_FILE = os.environ.get("AGENT_TOKEN_FILE", str(pathlib.Path.home() / ".agentic-browser" / "http-token"))
TOKEN = os.environ.get("AGENT_TOKEN") or (pathlib.Path(TOKEN_FILE).read_text().strip() if os.path.exists(TOKEN_FILE) else "")


def call(tool: str, **args) -> str:
    req = urllib.request.Request(
        f"{BASE}/tools/{tool}",
        data=json.dumps(args).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    if "error" in body:
        raise RuntimeError(body["error"])
    return body.get("result", body)


if __name__ == "__main__":
    print(call("browser_navigate", url="https://es.wikipedia.org", snapshot=True))
    print(call("browser_find", query="Buscar"))
    # Pick a ref from the output above, then for example:
    # print(call("browser_type", ref=3, text="Chrome DevTools Protocol", submit=True, snapshot=True))
