from __future__ import annotations

from pathlib import Path

from liveprobe_analysis.frontend import PythonFrontend


def write_source(tmp_path: Path, source: str) -> Path:
    path = tmp_path / "service.py"
    path.write_text(source, encoding="utf-8")
    return path


def test_extracts_def_use_control_calls_and_hammocks(tmp_path: Path) -> None:
    path = write_source(
        tmp_path,
        """
def calculate(rate, distance):
    subtotal = rate * distance
    if subtotal > 100:
        amount = subtotal * 0.9
    else:
        amount = subtotal
    return amount
""".lstrip(),
    )

    fragment = PythonFrontend().analyze_file(path, tmp_path)[0]

    assert fragment.parameters == ("rate", "distance")
    assert any(edge.kind == "DATA" and edge.variable == "subtotal" for edge in fragment.edges)
    assert any(edge.kind == "CONTROL" for edge in fragment.edges)
    assert all(
        edge.edge_id and edge.edge_id.startswith("edge_")
        for edge in fragment.edges
    )
    assert {hammock.kind for hammock in fragment.hammocks} >= {
        "function",
        "if:0",
        "if:1",
    }
    assert all(hammock.hammock_id.startswith("hmk_") for hammock in fragment.hammocks)


def test_marks_dynamic_execution_as_coverage_gap(tmp_path: Path) -> None:
    path = write_source(
        tmp_path,
        """
def run(expression):
    result = eval(expression)
    return result
""".lstrip(),
    )

    fragment = PythonFrontend().analyze_file(path, tmp_path)[0]

    assert any("dynamic execution" in note for note in fragment.coverage_notes)


def test_extracts_fastapi_route(tmp_path: Path) -> None:
    path = write_source(
        tmp_path,
        """
@app.post("/capture")
def capture(request):
    return {"amount": request.amount}
""".lstrip(),
    )

    fragment = PythonFrontend().analyze_file(path, tmp_path)[0]

    assert [(route.method, route.path) for route in fragment.routes] == [
        ("POST", "/capture")
    ]


def test_imported_call_targets_are_module_qualified() -> None:
    fragment = PythonFrontend().analyze_source(
        """
from common.faults import is_active as flag_on

def quote(config):
    surge = 50 if flag_on("surge_poison") else config["surge"]
    return surge
""".lstrip(),
        "services/pricing/app.py",
    )[0]

    call = next(value for value in fragment.calls if "is_active" in value.target)
    assert call.target == "common.faults.is_active"


def test_nested_return_flows_to_function_exit(tmp_path: Path) -> None:
    path = write_source(
        tmp_path,
        """
def choose(value):
    if value:
        return value
    result = 0
    return result
""".lstrip(),
    )

    fragment = PythonFrontend().analyze_file(path, tmp_path)[0]
    early_return = next(
        node
        for node in fragment.nodes
        if node.kind == "Return" and node.line == 3
    )
    cfg_targets = {
        edge.target
        for edge in fragment.edges
        if edge.kind == "CFG" and edge.source == early_return.node_id
    }

    assert cfg_targets == {fragment.exit_node}


def test_known_mutator_is_a_conservative_memory_write(tmp_path: Path) -> None:
    path = write_source(
        tmp_path,
        """
_chunks = []

def allocate():
    _chunks.append(bytearray(10))
    return len(_chunks)
""".lstrip(),
    )

    fragment = PythonFrontend().analyze_file(path, tmp_path)[0]
    mutation = next(node for node in fragment.nodes if node.line == 4)

    assert "_chunks" in mutation.defs
    assert "_chunks" in fragment.module_globals
