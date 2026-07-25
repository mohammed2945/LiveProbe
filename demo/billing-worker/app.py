from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from typing import Any

import liveprobe
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


def _env_flag(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "on", "true", "yes"}


SERVICE_ID = os.getenv("SERVICE_ID", "billing-worker")
BROKER_URL = os.getenv("BROKER_URL", "http://127.0.0.1:7070")
BUG_ENABLED = _env_flag("BUG", "on")
LIVEPROBE_ENABLED = _env_flag("LIVEPROBE_ENABLED", "on")


def _seed_users() -> dict[str, dict[str, object]]:
    legacy_address: dict[str, str] | None = (
        None
        if BUG_ENABLED
        else {"country": "US", "postal_code": "94107"}
    )
    return {
        "legacy-user": {
            "id": "legacy-user",
            "is_legacy": True,
            "address": legacy_address,
        },
        "standard-us": {
            "id": "standard-us",
            "is_legacy": False,
            "address": {"country": "US", "postal_code": "10001"},
        },
        "standard-eu": {
            "id": "standard-eu",
            "is_legacy": False,
            "address": {"country": "DE", "postal_code": "10115"},
        },
    }


USERS = _seed_users()


class RenewalRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=100)
    subtotal_cents: int = Field(default=2_500, ge=1, le=10_000_000)


class RenewalResponse(BaseModel):
    user_id: str
    subtotal_cents: int
    tax_cents: int
    total_cents: int


class BillingStats:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests_started = 0
        self._requests_completed = 0
        self._renewals_succeeded = 0
        self._renewals_failed = 0
        self._by_user: dict[str, dict[str, int]] = {}
        self._last_error: str | None = None

    def begin(self, user_id: str) -> int:
        with self._lock:
            self._requests_started += 1
            user_stats = self._by_user.setdefault(
                user_id, {"attempted": 0, "succeeded": 0, "failed": 0}
            )
            user_stats["attempted"] += 1
            return self._requests_started

    def succeed(self, user_id: str) -> None:
        with self._lock:
            self._requests_completed += 1
            self._renewals_succeeded += 1
            self._by_user[user_id]["succeeded"] += 1

    def fail(self, user_id: str, error: Exception) -> None:
        with self._lock:
            self._requests_completed += 1
            self._renewals_failed += 1
            self._by_user[user_id]["failed"] += 1
            self._last_error = f"{type(error).__name__}: {error}"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "requests_started": self._requests_started,
                "requests_completed": self._requests_completed,
                "requests_in_flight": (
                    self._requests_started - self._requests_completed
                ),
                "renewals_succeeded": self._renewals_succeeded,
                "renewals_failed": self._renewals_failed,
                "by_user": {
                    user_id: dict(user_stats)
                    for user_id, user_stats in self._by_user.items()
                },
                "last_error": self._last_error,
            }


STATS = BillingStats()


def calculate_tax_cents(user: dict[str, object], subtotal_cents: int) -> int:
    """Calculate renewal tax; the marked line is intentionally probe-stable."""
    postal_code = user["address"]["postal_code"]  # LIVEPROBE_BUG_LINE: keep stable for snapshot probes
    country = user["address"]["country"]
    if country == "US":
        rate_basis_points = 825 if str(postal_code).startswith("9") else 700
    else:
        rate_basis_points = 1_900
    return (subtotal_cents * rate_basis_points + 5_000) // 10_000


@asynccontextmanager
async def lifespan(app: FastAPI):
    agent = None
    if LIVEPROBE_ENABLED:
        agent = liveprobe.start(
            service_id=SERVICE_ID,
            broker_url=BROKER_URL,
            project_id=os.getenv("LIVEPROBE_PROJECT_ID"),
            environment=os.getenv("LIVEPROBE_ENVIRONMENT"),
            poll_interval=float(os.getenv("LIVEPROBE_POLL_INTERVAL", "1")),
            flush_interval=float(os.getenv("LIVEPROBE_FLUSH_INTERVAL", "2")),
        )
    app.state.liveprobe_started = agent is not None
    try:
        yield
    finally:
        if agent is not None:
            liveprobe.stop()


app = FastAPI(
    title="LiveProbe billing worker",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service_id": SERVICE_ID,
        "bug": "on" if BUG_ENABLED else "off",
        "liveprobe_started": bool(
            getattr(app.state, "liveprobe_started", False)
        ),
    }


@app.post("/renew", response_model=RenewalResponse)
def renew_subscription(request: RenewalRequest) -> RenewalResponse:
    user = USERS.get(request.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    STATS.begin(request.user_id)
    try:
        tax_cents = calculate_tax_cents(user, request.subtotal_cents)
    except Exception as error:
        STATS.fail(request.user_id, error)
        raise HTTPException(
            status_code=500,
            detail="subscription renewal tax calculation failed",
        ) from error

    STATS.succeed(request.user_id)
    return RenewalResponse(
        user_id=request.user_id,
        subtotal_cents=request.subtotal_cents,
        tax_cents=tax_cents,
        total_cents=request.subtotal_cents + tax_cents,
    )


@app.get("/stats")
def stats() -> dict[str, Any]:
    return STATS.snapshot()
