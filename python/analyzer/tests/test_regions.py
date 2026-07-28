from __future__ import annotations

from dataclasses import asdict

from liveprobe_analysis.model import FlowEdge, FlowNode
from liveprobe_analysis.regions import (
    build_graph_projections,
    build_segment_projection,
)


def node(
    name: str,
    line: int,
    *,
    kind: str = "Assign",
    defs: tuple[str, ...] = (),
    uses: tuple[str, ...] = (),
) -> dict[str, object]:
    return asdict(
        FlowNode(
            node_id=name,
            kind=kind,
            file="service.py",
            function_id="service.py:fare",
            line=line,
            end_line=line,
            source=name,
            defs=defs,
            uses=uses,
            probe_line=line,
        )
    )


def edge(
    source: str,
    target: str,
    variable: str,
    *,
    kind: str = "DATA",
    certainty: str = "MUST",
) -> dict[str, object]:
    return asdict(
        FlowEdge(
            source=source,
            target=target,
            kind=kind,  # type: ignore[arg-type]
            variable=variable,
            certainty=certainty,  # type: ignore[arg-type]
        )
    )


def test_unbranched_interior_is_contracted_without_losing_members() -> None:
    nodes = [
        node("n1", 1, defs=("a",), uses=("raw",)),
        node("n2", 2, defs=("b",), uses=("a",)),
        node("n3", 3, defs=("c",), uses=("b",)),
        node("n4", 4, defs=("d",), uses=("c",)),
        node("n5", 5, kind="Return", defs=("return",), uses=("d",)),
    ]
    edges = [
        edge("n1", "n2", "a"),
        edge("n2", "n3", "b"),
        edge("n3", "n4", "c"),
        edge("n4", "n5", "d"),
    ]

    projection = build_segment_projection(
        nodes,
        edges,
        manifestation_node_id="n5",
    )

    middle = next(
        region
        for region in projection.regions
        if {"n2", "n3", "n4"} <= set(region.member_node_ids)
    )
    assert middle.kind == "TRANSFORM"
    assert middle.child_region_ids
    assert {
        member
        for region in projection.regions
        for member in region.member_node_ids
    } == {"n1", "n2", "n3", "n4", "n5"}


def test_decisions_uncertainty_and_fan_in_are_never_hidden() -> None:
    nodes = [
        node("predicate", 1, kind="If", uses=("enabled",)),
        node("left", 2, defs=("value",), uses=("configured",)),
        node("right", 3, defs=("value",), uses=("fallback",)),
        node("join", 4, defs=("selected",), uses=("value",)),
        node("sink", 5, kind="Return", defs=("return",), uses=("selected",)),
    ]
    edges = [
        edge("predicate", "left", "enabled", kind="CONTROL"),
        edge("predicate", "right", "enabled", kind="CONTROL"),
        edge("left", "join", "value"),
        edge("right", "join", "value", certainty="MAY"),
        edge("join", "sink", "selected"),
    ]

    projection = build_segment_projection(
        nodes,
        edges,
        manifestation_node_id="sink",
    )
    by_member = {
        member: region
        for region in projection.regions
        for member in region.member_node_ids
    }

    assert by_member["predicate"].kind == "DECISION"
    assert by_member["predicate"].member_node_ids == ("predicate",)
    assert by_member["join"].member_node_ids == ("join",)
    assert by_member["right"].certainty == "MAY"
    assert by_member["left"].region_id != by_member["right"].region_id


def test_cycles_become_explicit_regions() -> None:
    nodes = [
        node("entry", 1, defs=("value",), uses=("raw",)),
        node("loop_a", 2, defs=("value",), uses=("value",)),
        node("loop_b", 3, defs=("value",), uses=("value",)),
        node("sink", 4, kind="Return", defs=("return",), uses=("value",)),
    ]
    edges = [
        edge("entry", "loop_a", "value"),
        edge("loop_a", "loop_b", "value"),
        edge("loop_b", "loop_a", "value"),
        edge("loop_b", "sink", "value"),
    ]

    projection = build_segment_projection(
        nodes,
        edges,
        manifestation_node_id="sink",
    )

    cycle = next(region for region in projection.regions if region.kind == "CYCLE")
    assert set(cycle.member_node_ids) == {"loop_a", "loop_b"}


def test_every_canonical_edge_survives_internally_or_as_region_edge() -> None:
    nodes = [
        node("n1", 1, defs=("a",), uses=("raw",)),
        node("n2", 2, defs=("b",), uses=("a",)),
        node("n3", 3, defs=("c",), uses=("b",)),
        node("n4", 4, kind="Return", defs=("return",), uses=("c",)),
    ]
    edges = [
        edge("n1", "n2", "a"),
        edge("n2", "n3", "b"),
        edge("n3", "n4", "c"),
    ]
    projection = build_segment_projection(
        nodes,
        edges,
        manifestation_node_id="n4",
    )
    member_region = {
        member: region.region_id
        for region in projection.regions
        for member in region.member_node_ids
    }
    projected_pairs = {
        (value.source_region_id, value.target_region_id)
        for value in projection.edges
    }

    for value in edges:
        source = member_region[str(value["source"])]
        target = member_region[str(value["target"])]
        assert source == target or (source, target) in projected_pairs


def test_graph_exposes_all_four_projection_levels() -> None:
    nodes = [
        node("producer", 1, defs=("quote",), uses=("config",)),
        node("sink", 2, kind="Return", defs=("return",), uses=("quote",)),
    ]
    projections = build_graph_projections(
        nodes=nodes,
        edges=[edge("producer", "sink", "quote")],
        collapsed_functions=[],
        branches=[],
        traversals=[
            {
                "traversal_id": "trv_pricing",
                "function_id": "service.py:fare",
                "service_id": "pricing",
                "parent_traversal_ids": [],
                "incoming_hops": [],
            }
        ],
        manifestation_node_id="sink",
        focus_node_ids=("producer", "sink"),
        focus_traversal_ids=("trv_pricing",),
    )

    assert set(projections) == {
        "boundary",
        "function",
        "segment",
        "statement",
    }
    assert projections["function"]["regions"][0]["runtime_owner"] is None
    assert projections["boundary"]["regions"][0]["runtime_owner"] == "pricing"
    assert len(projections["statement"]["regions"]) == 2
