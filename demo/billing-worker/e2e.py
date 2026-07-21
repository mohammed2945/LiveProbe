from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


DEMO_DIR = Path(__file__).resolve().parent
REPO_ROOT = DEMO_DIR.parent.parent
APP_SOURCE = DEMO_DIR / "app.py"
BROKER_ENTRY = REPO_ROOT / "packages" / "broker" / "dist" / "src" / "index.js"
SERVICE_ID = "billing-worker-e2e"
PROBE_FILE = "app.py"
COMMIT_SHA = "abcdef1234567890"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _json_request(
    method: str,
    url: str,
    payload: dict[str, object] | None = None,
    *,
    timeout: float = 3.0,
) -> tuple[int, dict[str, Any]]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=body, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read()
    decoded = json.loads(raw) if raw else {}
    if not isinstance(decoded, dict):
        raise AssertionError(f"{method} {url} returned a non-object JSON body")
    return status, decoded


def _wait_for(
    description: str,
    predicate: Callable[[], Any],
    *,
    timeout: float = 15.0,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...] = (),
) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        for name, process in processes:
            return_code = process.poll()
            if return_code is not None:
                raise RuntimeError(
                    f"{name} exited before {description} (code {return_code})"
                )
        try:
            result = predicate()
            if result:
                return result
        except (
            AssertionError,
            OSError,
            ValueError,
            urllib.error.URLError,
        ) as error:
            last_error = error
        time.sleep(0.05)
    detail = f": {last_error}" if last_error is not None else ""
    raise TimeoutError(f"timed out waiting for {description}{detail}")


def _terminate(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _read_log(path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return "<log unavailable>"
    return "\n".join(lines[-60:])


def _bug_line() -> int:
    matches = [
        line_number
        for line_number, line in enumerate(
            APP_SOURCE.read_text(encoding="utf-8").splitlines(), start=1
        )
        if "LIVEPROBE_BUG_LINE:" in line
    ]
    if len(matches) != 1:
        raise AssertionError(
            f"expected one LIVEPROBE_BUG_LINE marker, found {len(matches)}"
        )
    return matches[0]


def _service_is_ready(broker_url: str) -> bool:
    status, payload = _json_request("GET", f"{broker_url}/v1/services")
    if status != 200:
        return False
    services = payload.get("services", [])
    return any(
        isinstance(service, dict)
        and service.get("serviceId") == SERVICE_ID
        and service.get("sdk") == "python"
        and isinstance(service.get("agentStatus"), dict)
        and service["agentStatus"].get("state") == "green"
        for service in services
    )


def _stats(app_url: str) -> dict[str, Any]:
    status, payload = _json_request("GET", f"{app_url}/stats")
    if status != 200:
        raise AssertionError(f"stats endpoint returned HTTP {status}")
    return payload


def _completed_requests(app_url: str) -> int:
    payload = _stats(app_url)
    completed = payload.get("requests_completed", 0)
    return completed if isinstance(completed, int) else 0


def _snapshot_event(
    broker_url: str, probe_id: str
) -> dict[str, Any] | None:
    encoded_probe_id = urllib.parse.quote(probe_id, safe="")
    status, payload = _json_request(
        "GET", f"{broker_url}/v1/probes/{encoded_probe_id}/data?waitSeconds=1"
    )
    if status != 200:
        return None
    events = payload.get("events", [])
    if not isinstance(events, list):
        return None
    for event in events:
        if isinstance(event, dict) and event.get("type") == "snapshot":
            return event
    return None


def _child(node: object, key: str) -> dict[str, Any]:
    if not isinstance(node, dict) or node.get("t") != "obj":
        raise AssertionError(f"expected serialized object while reading {key}")
    children = node.get("c")
    if not isinstance(children, dict):
        raise AssertionError(f"serialized object has no children while reading {key}")
    child = children.get(key)
    if not isinstance(child, dict):
        raise AssertionError(f"serialized evidence is missing {key}")
    return child


def _assert_sanitized_evidence(event: dict[str, Any]) -> None:
    user = _child(event.get("variables"), "user")
    address = _child(user, "address")
    is_legacy = _child(user, "is_legacy")
    if address != {"t": "null", "v": None}:
        raise AssertionError(f"user.address was not sanitized null: {address}")
    if is_legacy != {"t": "bool", "v": True}:
        raise AssertionError(f"user.is_legacy was not sanitized true: {is_legacy}")

    watches = event.get("watches")
    if not isinstance(watches, dict):
        raise AssertionError("snapshot did not include sanitized watches")
    if watches.get("user.address") != {"t": "null", "v": None}:
        raise AssertionError("user.address watch did not show sanitized null")
    if watches.get("user.is_legacy") != {"t": "bool", "v": True}:
        raise AssertionError("user.is_legacy watch did not show sanitized true")


def main() -> int:
    if sys.version_info < (3, 12):
        raise RuntimeError("billing-worker e2e requires Python 3.12+")
    if not BROKER_ENTRY.is_file():
        raise RuntimeError(
            f"built broker entrypoint is missing: {BROKER_ENTRY}; "
            "build @liveprobe/broker before running this demo"
        )

    broker_port = _free_port()
    app_port = _free_port()
    broker_url = f"http://127.0.0.1:{broker_port}"
    app_url = f"http://127.0.0.1:{app_port}"
    python_path = str(REPO_ROOT / "python" / "sdk" / "src")
    existing_python_path = os.environ.get("PYTHONPATH")
    if existing_python_path:
        python_path = os.pathsep.join((python_path, existing_python_path))

    broker: subprocess.Popen[bytes] | None = None
    app: subprocess.Popen[bytes] | None = None
    traffic: subprocess.Popen[bytes] | None = None
    probe_id: str | None = None

    with tempfile.TemporaryDirectory(prefix="liveprobe-python-e2e-") as temporary:
        temporary_path = Path(temporary)
        broker_log = temporary_path / "broker.log"
        app_log = temporary_path / "app.log"
        traffic_log = temporary_path / "traffic.log"
        try:
            with (
                broker_log.open("wb") as broker_output,
                app_log.open("wb") as app_output,
                traffic_log.open("wb") as traffic_output,
            ):
                broker_env = os.environ.copy()
                broker_env.update(
                    {
                        "HOST": "127.0.0.1",
                        "PORT": str(broker_port),
                    }
                )
                broker_env.pop("LIVEPROBE_STATE_FILE", None)
                broker = subprocess.Popen(
                    ["node", str(BROKER_ENTRY)],
                    cwd=REPO_ROOT,
                    env=broker_env,
                    stdout=broker_output,
                    stderr=subprocess.STDOUT,
                )
                _wait_for(
                    "broker readiness",
                    lambda: _json_request("GET", f"{broker_url}/v1/services")[0]
                    == 200,
                    timeout=10,
                    processes=(("broker", broker),),
                )

                app_env = os.environ.copy()
                app_env.update(
                    {
                        "BUG": "on",
                        "SERVICE_ID": SERVICE_ID,
                        "BROKER_URL": broker_url,
                        "GIT_COMMIT": COMMIT_SHA,
                        "LIVEPROBE_ENABLED": "on",
                        "LIVEPROBE_POLL_INTERVAL": "0.1",
                        "LIVEPROBE_FLUSH_INTERVAL": "0.25",
                        "PYTHONPATH": python_path,
                        "PYTHONUNBUFFERED": "1",
                    }
                )
                app = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        "app:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(app_port),
                        "--log-level",
                        "warning",
                    ],
                    cwd=DEMO_DIR,
                    env=app_env,
                    stdout=app_output,
                    stderr=subprocess.STDOUT,
                )

                def app_is_ready() -> bool:
                    status, health = _json_request("GET", f"{app_url}/health")
                    return (
                        status == 200
                        and health.get("bug") == "on"
                        and health.get("liveprobe_started") is True
                    )

                _wait_for(
                    "billing worker readiness",
                    app_is_ready,
                    timeout=10,
                    processes=(("broker", broker), ("app", app)),
                )
                _wait_for(
                    "Python SDK broker registration",
                    lambda: _service_is_ready(broker_url),
                    timeout=10,
                    processes=(("broker", broker), ("app", app)),
                )

                traffic = subprocess.Popen(
                    [
                        sys.executable,
                        str(DEMO_DIR / "traffic.py"),
                        "--base-url",
                        app_url,
                        "--interval",
                        "0.03",
                    ],
                    cwd=DEMO_DIR,
                    env=app_env,
                    stdout=traffic_output,
                    stderr=subprocess.STDOUT,
                )
                active_processes = (
                    ("broker", broker),
                    ("app", app),
                    ("traffic", traffic),
                )
                _wait_for(
                    "initial mixed-user traffic",
                    lambda: _completed_requests(app_url) >= 8,
                    timeout=10,
                    processes=active_processes,
                )
                initial_stats = _stats(app_url)
                if (
                    initial_stats.get("renewals_succeeded", 0) <= 0
                    or initial_stats.get("renewals_failed", 0) <= 0
                ):
                    raise AssertionError(
                        "mixed traffic did not exercise successful and failing renewals"
                    )
                before_probe = int(initial_stats["requests_completed"])

                create_status, create_payload = _json_request(
                    "POST",
                    f"{broker_url}/v1/probes",
                    {
                        "serviceId": SERVICE_ID,
                        "type": "snapshot",
                        "file": PROBE_FILE,
                        "line": _bug_line(),
                        "condition": {
                            "path": "user.is_legacy",
                            "op": "eq",
                            "value": True,
                        },
                        "watchPaths": ["user.address", "user.is_legacy"],
                        "hitLimit": 1,
                        "ttlSeconds": 60,
                        "createdBy": "e2e:billing-worker",
                    },
                )
                if create_status != 201:
                    raise AssertionError(
                        f"probe creation failed ({create_status}): {create_payload}"
                    )
                probe = create_payload.get("probe")
                if not isinstance(probe, dict) or not isinstance(
                    probe.get("id"), str
                ):
                    raise AssertionError("broker did not return a probe id")
                probe_id = probe["id"]

                evidence = _wait_for(
                    "conditioned snapshot evidence",
                    lambda: _snapshot_event(broker_url, probe_id),
                    timeout=15,
                    processes=active_processes,
                )
                if not isinstance(evidence, dict):
                    raise AssertionError("snapshot evidence was not an object")
                _assert_sanitized_evidence(evidence)

                at_evidence = _completed_requests(app_url)
                if at_evidence <= before_probe:
                    raise AssertionError(
                        "request counter did not advance while collecting evidence"
                    )
                after_evidence = _wait_for(
                    "continued requests after snapshot",
                    lambda: (
                        count
                        if (count := _completed_requests(app_url))
                        >= at_evidence + 5
                        else 0
                    ),
                    timeout=5,
                    processes=active_processes,
                )

                print(
                    json.dumps(
                        {
                            "result": "PASS",
                            "probe_id": probe_id,
                            "bug_line": _bug_line(),
                            "evidence": {
                                "user.address": None,
                                "user.is_legacy": True,
                            },
                            "request_counters": {
                                "before_probe": before_probe,
                                "at_evidence": at_evidence,
                                "after_evidence": after_evidence,
                            },
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
        except Exception:
            print("\n--- broker.log ---", file=sys.stderr)
            print(_read_log(broker_log), file=sys.stderr)
            print("\n--- app.log ---", file=sys.stderr)
            print(_read_log(app_log), file=sys.stderr)
            print("\n--- traffic.log ---", file=sys.stderr)
            print(_read_log(traffic_log), file=sys.stderr)
            raise
        finally:
            if probe_id is not None:
                try:
                    encoded_probe_id = urllib.parse.quote(probe_id, safe="")
                    _json_request(
                        "DELETE",
                        f"{broker_url}/v1/probes/{encoded_probe_id}",
                        timeout=1,
                    )
                except Exception:
                    pass
            _terminate(traffic)
            _terminate(app)
            _terminate(broker)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
