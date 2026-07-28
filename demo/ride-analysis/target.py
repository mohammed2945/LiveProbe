#!/usr/bin/env python3
"""Run the real RideRush payments app against a deterministic local data source."""

from __future__ import annotations

import argparse
import importlib
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi import FastAPI, Request


@dataclass
class _Response:
    data: list[dict[str, Any]]


class _Query:
    def __init__(self, table: str) -> None:
        self.table = table

    def select(self, *_args: object, **_kwargs: object) -> _Query:
        return self

    def eq(self, *_args: object, **_kwargs: object) -> _Query:
        return self

    def limit(self, *_args: object, **_kwargs: object) -> _Query:
        return self

    def is_(self, *_args: object, **_kwargs: object) -> _Query:
        return self

    def upsert(self, *_args: object, **_kwargs: object) -> _Query:
        return self

    def execute(self) -> _Response:
        if self.table == "pricing_config":
            return _Response(
                [{"per_mile_rate": 2.45, "base_fare": 3.5, "surge": 1.0}]
            )
        if self.table == "fare_runtime_config":
            return _Response(
                [
                    {
                        "tax_multiplier": "US-CA:1.0825",
                        "partner_discount": 0.0,
                    }
                ]
            )
        if self.table == "payments":
            return _Response([])
        if self.table == "active_faults":
            return _Response([])
        raise RuntimeError(f"unexpected RideRush table {self.table!r}")


class _Client:
    def table(self, name: str) -> _Query:
        return _Query(name)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ride-root", type=Path, required=True)
    parser.add_argument("--broker-url", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--scenario",
        choices=("gateway", "payments", "pricing"),
        default="payments",
    )
    parser.add_argument("--pricing-url")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ride_root = args.ride_root.resolve()
    # The harness places the workspace SDK before RideRush on PYTHONPATH.
    # Preserve that ordering because RideRush also has an unrelated local
    # package named ``liveprobe``.
    if str(ride_root) not in sys.path:
        sys.path.append(str(ride_root))

    # Import the real application without letting RideRush's published SDK
    # bootstrap. The current workspace SDK is started immediately afterward.
    os.environ["LIVEPROBE_ENABLED"] = "0"
    os.environ["STACK_ID"] = "e2e"
    os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:1")
    os.environ.setdefault("SUPABASE_SERVICE_KEY", "local-e2e")

    # RideRush starts its production fault poller at import time. Replace only
    # that integration module in this isolated harness so no cloud connection
    # or background thread can leak into benchmark timing.
    ride_faults = ModuleType("common.faults")
    ride_faults.__dict__.update(
        {
            "_active_flags": set(),
            "_flags_lock": threading.RLock(),
        }
    )
    # Preserve the deployed source filename and exact is_active line mapping so
    # graph-guided probes observe the same function that static analysis
    # indexed, while still avoiding the production cloud poller.
    exec(
        compile(
            "\n" * 81
            + '''def is_active(name: str) -> bool:
    """Return whether a fault was present in the latest successful poll."""
    with _flags_lock:
        return name in _active_flags
''',
            str(ride_root / "common/faults.py"),
            "exec",
        ),
        ride_faults.__dict__,
    )
    ride_faults.start_fault_poller = lambda: None  # type: ignore[attr-defined]
    sys.modules["common.faults"] = ride_faults

    import common.http as ride_http

    ride_http.emit = lambda *_args, **_kwargs: None
    ride_http.is_active = lambda _name: False
    if args.scenario == "gateway":
        if not args.pricing_url:
            raise ValueError("--pricing-url is required for the gateway scenario")
        own_url = f"http://127.0.0.1:{args.port}"
        os.environ["PRICING_URL"] = args.pricing_url
        os.environ["MATCHING_URL"] = own_url
        os.environ["TRIPS_URL"] = own_url
        target_module = importlib.import_module("services.gateway.app")
        target_app = target_module.app

        @target_app.post("/assign")
        def assign() -> dict[str, str]:
            return {"driver_id": "driver-e2e"}

        @target_app.post("/trips")
        def create_trip() -> dict[str, str]:
            return {"id": "trip-e2e"}
    elif args.scenario == "payments":
        target_module = importlib.import_module("services.payments.app")

        target_module.get_client = lambda: _Client()
        target_app = target_module.app
    else:
        target_module = importlib.import_module("services.pricing.app")

        target_module.get_client = lambda: _Client()
        target_app = FastAPI(title="RideRush pricing investigation target")

        @target_app.get("/healthz")
        def healthz() -> dict[str, str]:
            return {"status": "ok"}

        @target_app.get("/quote")
        def quote(
            request: Request,
            x: int,
            y: int,
            dest_x: int,
            dest_y: int,
        ) -> dict[str, float | int]:
            poisoned = (
                request.headers.get("x-riderush-fault") == "surge_poison"
                or "fail"
                in request.headers.get(
                    "x-liveprobe-replay-id", ""
                ).lower()
            )
            with ride_faults._flags_lock:  # type: ignore[attr-defined]
                ride_faults._active_flags = (  # type: ignore[attr-defined]
                    {"surge_poison"} if poisoned else set()
                )
            return target_module.quote(x, y, dest_x, dest_y)

    import liveprobe

    liveprobe.instrument_fastapi(target_app)
    liveprobe.start(
        service_id=f"{args.scenario}-e2e",
        broker_url=args.broker_url,
        commit_sha=args.commit,
        environment="e2e",
        service_instance=f"{args.scenario}-e2e-local",
        poll_interval=0.1,
        flush_interval=0.1,
        # This is an isolated benchmark process. A larger callback budget keeps
        # six simultaneous one-hit probes from tripping the production safety
        # cooldown between experiment rounds.
        limits={"pauseBudgetMs": 1_000, "hitsPerSec": 1_000},
    )

    import uvicorn

    uvicorn.run(target_app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
