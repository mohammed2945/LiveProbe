from __future__ import annotations

import subprocess
from pathlib import Path

from liveprobe_analysis import AnalysisCriterion, AnalysisEngine
from liveprobe_analysis.cache import AnalysisCache
from liveprobe_analysis.engine import ProjectGraph


def commit_repository(root: Path) -> str:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=root,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


def test_field_sensitive_durable_boundary_reaches_writer(
    tmp_path: Path,
) -> None:
    (tmp_path / "pricing.py").write_text(
        """
def refresh(rate, stack_id):
    response = (
        get_client()
        .table("pricing_config")
        .update({"per_mile_rate": rate})
        .eq("stack_id", stack_id)
        .execute()
    )
    return response
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "payments.py").write_text(
        """
def capture(request, stack_id):
    response = (
        get_client()
        .table("pricing_config")
        .select("per_mile_rate")
        .eq("stack_id", stack_id)
        .execute()
    )
    pricing = response.data[0]
    fare_inputs = {"per_mile_rate": pricing["per_mile_rate"], "distance": request.distance}
    subtotal = fare_inputs["per_mile_rate"] * fare_inputs["distance"]
    return subtotal
""".lstrip(),
        encoding="utf-8",
    )
    commit = commit_repository(tmp_path)
    cache_path = tmp_path / "analysis.sqlite3"
    engine = AnalysisEngine(str(tmp_path), str(cache_path))
    engine.prepare(commit)

    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(tmp_path),
            commit=commit,
            service_id="payments",
            file="payments.py",
            line=11,
            watch_path="fare_inputs.per_mile_rate",
        )
    )
    with AnalysisCache(tmp_path, cache_path) as cache:
        graph = ProjectGraph(cache.load_fragments(commit))
    locations = {
        (graph.nodes[node_id].file, graph.nodes[node_id].line)
        for node_id in plan.slice_node_ids
    }

    assert any(edge.kind == "DURABLE_BOUNDARY" for edge in plan.slice_edges)
    assert ("pricing.py", 2) in locations


def test_http_response_boundary_reaches_route_return(tmp_path: Path) -> None:
    (tmp_path / "pricing.py").write_text(
        """
@app.get("/quote")
def quote(x):
    amount = x * 2
    return {"quote": amount}
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "gateway.py").write_text(
        """
def request_quote(x):
    response = httpx.get("http://pricing/quote", params={"x": x})
    pricing = response.json()
    result = {"quote": pricing["quote"]}
    return result
""".lstrip(),
        encoding="utf-8",
    )
    commit = commit_repository(tmp_path)
    cache_path = tmp_path / "analysis.sqlite3"
    engine = AnalysisEngine(str(tmp_path), str(cache_path))
    engine.prepare(commit)

    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(tmp_path),
            commit=commit,
            service_id="gateway",
            file="gateway.py",
            line=4,
            watch_path="result.quote",
        )
    )
    with AnalysisCache(tmp_path, cache_path) as cache:
        graph = ProjectGraph(cache.load_fragments(commit))
    locations = {
        (graph.nodes[node_id].file, graph.nodes[node_id].line)
        for node_id in plan.slice_node_ids
    }

    assert any(edge.kind == "HTTP_BOUNDARY" for edge in plan.slice_edges)
    assert ("pricing.py", 4) in locations
