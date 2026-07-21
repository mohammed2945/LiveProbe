from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


@pytest.mark.skipif(
    not hasattr(sys, "monitoring"), reason="sys.monitoring requires Python 3.12+"
)
def test_real_monitoring_callback_selects_instrumented_frame() -> None:
    script = textwrap.dedent(
        """
        from liveprobe.runtime import LiveProbe

        agent = LiveProbe(
            service_id="smoke",
            broker_url="http://127.0.0.1:1",
            commit_sha="abcdef1234567890",
            limits={"hitsPerSec": 100, "pauseBudgetMs": 1000},
        )

        def target():
            marker = {"value": 7}
            return marker

        definition = {
            "id": "prb_smoke",
            "serviceId": "smoke",
            "type": "snapshot",
            "file": "<string>",
            "line": target.__code__.co_firstlineno + 2,
            "hitLimit": 1,
            "ttlSeconds": 30,
            "version": 1,
            "createdBy": "pytest",
        }

        try:
            agent._install_monitoring()
            agent._reconcile([definition])
            target()
            agent._drain_queue()
            snapshots = [
                event for event in agent._events if event["type"] == "snapshot"
            ]
            assert snapshots
            assert snapshots[0]["variables"]["c"]["marker"]["c"]["value"] == {
                "t": "num", "v": 7
            }
        finally:
            agent._uninstall_monitoring()
        """
    )
    sdk_root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    existing = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = (
        f"{sdk_root / 'src'}{os.pathsep}{existing}"
        if existing
        else str(sdk_root / "src")
    )

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=sdk_root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
