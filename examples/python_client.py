"""Minimal client for the agentic-browser HTTP API (start it with `npm run http`).

Uses only the standard library. Set AGENT_TOKEN in both processes if you enabled it.
"""
import json
import os
import urllib.request

BASE = os.environ.get("AGENT_URL", "http://127.0.0.1:8787")
TOKEN = os.environ.get("AGENT_TOKEN", "")


def call(tool: str, **args) -> str:
    req = urllib.request.Request(
        f"{BASE}/tools/{tool}",
        data=json.dumps(args).encode(),
        headers={"content-type": "application/json", **({"authorization": f"Bearer {TOKEN}"} if TOKEN else {})},
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
