from __future__ import annotations

import subprocess
from pathlib import Path

from liveprobe_analysis import AnalysisCriterion, AnalysisEngine
from liveprobe_analysis.model import CandidateAssessment


def repository(tmp_path: Path) -> tuple[Path, str]:
    (tmp_path / "service.py").write_text(
        """
def normalize(raw):
    cleaned = raw.replace(",", ".")
    return float(cleaned)

def fare(raw, miles):
    rate = normalize(raw)
    subtotal = rate * miles
    amount = subtotal + 2
    return amount
""".lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "service.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    return tmp_path, commit


def test_prepares_slices_and_refines(tmp_path: Path) -> None:
    root, commit = repository(tmp_path)
    engine = AnalysisEngine(str(root), str(tmp_path / "analysis.sqlite3"))

    prepared = engine.prepare(commit)
    assert prepared["functions"] == 2

    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=9,
            watch_path="amount",
        )
    )

    sliced_sources = {
        edge.variable for edge in plan.slice_edges if edge.kind == "DATA"
    }
    assert {"amount", "subtotal", "rate"} <= sliced_sources
    assert any(edge.kind == "CALL_RETURN" for edge in plan.slice_edges)
    assert plan.frontier

    updated = engine.refine(
        plan.plan_id,
        [
            CandidateAssessment(
                candidate_id=plan.frontier[0].candidate_id,
                classification="bad",
            )
        ],
    )
    assert updated.round == 2
    assert updated.status in {"ACTIVE", "LOCALIZED", "INSUFFICIENT"}


def test_incremental_prepare_reuses_unchanged_file(tmp_path: Path) -> None:
    root, commit = repository(tmp_path)
    engine = AnalysisEngine(str(root), str(tmp_path / "analysis.sqlite3"))

    first = engine.prepare(commit)
    second = engine.prepare(commit)

    assert first["indexedFiles"] == 1
    assert second["indexedFiles"] == 0
    assert second["reusedFiles"] == 1


def test_prepare_reads_requested_git_blobs_not_dirty_worktree(
    tmp_path: Path,
) -> None:
    root, commit = repository(tmp_path)
    (root / "service.py").write_text("this is not valid python !!!\n")
    engine = AnalysisEngine(str(root), str(tmp_path / "analysis.sqlite3"))

    prepared = engine.prepare(commit)
    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=9,
            watch_path="amount",
        )
    )

    assert prepared["functions"] == 2
    assert plan.frontier


def test_cache_retains_multiple_revisions_of_the_same_path(
    tmp_path: Path,
) -> None:
    root, first_commit = repository(tmp_path)
    engine = AnalysisEngine(str(root), str(tmp_path / "analysis.sqlite3"))
    engine.prepare(first_commit)
    with (root / "service.py").open("a", encoding="utf-8") as stream:
        stream.write("\ndef extra(value):\n    return value\n")
    subprocess.run(["git", "add", "service.py"], cwd=root, check=True)
    subprocess.run(
        ["git", "commit", "-qm", "second revision"],
        cwd=root,
        check=True,
    )
    second_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()

    second = engine.prepare(second_commit)
    first_again = engine.prepare(first_commit)
    old_plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(root),
            commit=first_commit,
            service_id="fare",
            file="service.py",
            line=9,
            watch_path="amount",
        )
    )

    assert second["indexedFiles"] == 1
    assert first_again["indexedFiles"] == 0
    assert first_again["reusedFiles"] == 1
    assert all("extra" not in node_id for node_id in old_plan.slice_node_ids)


def test_expression_criterion_tracks_all_referenced_values(tmp_path: Path) -> None:
    root, commit = repository(tmp_path)
    engine = AnalysisEngine(str(root), str(tmp_path / "analysis.sqlite3"))
    engine.prepare(commit)

    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=9,
            expression="amount + miles",
        )
    )

    variables = {
        edge.variable for edge in plan.slice_edges if edge.kind == "DATA"
    }
    assert "amount" in variables
    assert "miles" in variables


def test_bad_external_read_is_exonerated_after_runtime_assessment(
    tmp_path: Path,
) -> None:
    (tmp_path / "external.py").write_text(
        """
def compute(client):
    response = client.table("runtime_config").select("multiplier").execute()
    multiplier = response.data[0]["multiplier"]
    amount = multiplier * 2
    return amount
""".lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "external.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    engine = AnalysisEngine(str(tmp_path), str(tmp_path / "analysis.sqlite3"))
    engine.prepare(commit)
    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(tmp_path),
            commit=commit,
            service_id="external",
            file="external.py",
            line=4,
            watch_path="amount",
        )
    )
    external = next(
        candidate
        for candidate in plan.frontier
        if "response" in candidate.watch_paths
    )

    updated = engine.refine(
        plan.plan_id,
        [
            CandidateAssessment(
                candidate_id=external.candidate_id,
                classification="bad",
            )
        ],
    )

    assert updated.status == "EXONERATED"
    assert updated.likely_hammock_id is not None


def test_module_shared_mutation_crosses_function_boundary(tmp_path: Path) -> None:
    (tmp_path / "memory.py").write_text(
        """
_values = []

def add(value):
    _values.append(value)

def size():
    current = len(_values)
    return current
""".lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "memory.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    engine = AnalysisEngine(str(tmp_path), str(tmp_path / "analysis.sqlite3"))
    engine.prepare(commit)

    plan = engine.analyze(
        AnalysisCriterion(
            repository_root=str(tmp_path),
            commit=commit,
            service_id="memory",
            file="memory.py",
            line=8,
            watch_path="current",
        )
    )

    assert any(
        edge.kind == "MEMORY_MAY" and edge.variable == "_values"
        for edge in plan.slice_edges
    )
