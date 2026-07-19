"""Verify the Supabase objects required by CONTRACT.md are accessible."""

from __future__ import annotations

import json
import os
import ssl
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
STACK_ID = "arena"
TABLES = ("events", "active_faults", "origin_events")
SYSTEM_CA_FILE = Path("/etc/ssl/cert.pem")


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def query(resource: str, select: str = "*") -> list[dict[str, object]]:
    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_KEY"]
    params = urlencode(
        {"select": select, "stack_id": f"eq.{STACK_ID}", "limit": "1"}
    )
    request = Request(
        f"{base_url}/rest/v1/{resource}?{params}",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Accept": "application/json",
        },
    )
    ssl_context = ssl.create_default_context(
        cafile=str(SYSTEM_CA_FILE) if SYSTEM_CA_FILE.exists() else None
    )
    with urlopen(request, timeout=10, context=ssl_context) as response:
        payload = json.load(response)
    if not isinstance(payload, list):
        raise ValueError(f"{resource} returned a non-list response")
    return payload


def main() -> int:
    load_env()
    missing_env = [
        key
        for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
        if not os.environ.get(key)
    ]
    if missing_env:
        print(f"Missing environment value: {missing_env[0]}", file=sys.stderr)
        return 2
    if os.environ.get("STACK_ID") != STACK_ID:
        print("STACK_ID must be arena", file=sys.stderr)
        return 2

    failed = False
    for table in TABLES:
        try:
            rows = query(table)
            print(f"PASS {table}: accessible ({len(rows)} row returned)")
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            failed = True
            detail = f"HTTP {exc.code}" if isinstance(exc, HTTPError) else str(exc)
            print(f"FAIL {table}: {detail}", file=sys.stderr)

    try:
        rows = query("stack_health", "stranded_now")
        print(
            "PASS stack_health: stranded_now column is accessible "
            f"({len(rows)} row returned)"
        )
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        failed = True
        detail = f"HTTP {exc.code}" if isinstance(exc, HTTPError) else str(exc)
        print(f"FAIL stack_health.stranded_now: {detail}", file=sys.stderr)

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
