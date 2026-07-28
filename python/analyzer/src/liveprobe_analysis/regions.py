"""Lossless multi-resolution projections of an investigation dependence graph."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import asdict
from typing import Any, Iterable

from .model import (
    DependenceRegion,
    EdgeKind,
    GraphProjection,
    RegionEdge,
    RegionKind,
)

_CERTAINTY_RANK = {"MUST": 0, "MAY": 1, "UNKNOWN": 2}
_PROJECTION_VERSION = 2
_DEPENDENCE_KINDS = {
    "DATA",
    "CONTROL",
    "CALL_RETURN",
    "HTTP_BOUNDARY",
    "DURABLE_BOUNDARY",
    "MEMORY_MAY",
    "UNKNOWN",
}
_DECISION_PREFIXES = (
    "If",
    "While",
    "For",
    "AsyncFor",
    "Match",
    "Try",
)


def _identifier(prefix: str, *parts: object) -> str:
    encoded = "\0".join(
        str(part) for part in (_PROJECTION_VERSION, *parts)
    ).encode()
    return f"{prefix}_{hashlib.sha256(encoded).hexdigest()[:24]}"


def _certainty(values: Iterable[str]) -> str:
    return max(values, key=lambda value: _CERTAINTY_RANK[value], default="MUST")


def _region_kind(
    members: list[dict[str, Any]],
    incident_edges: list[dict[str, Any]],
    *,
    cyclic: bool,
) -> RegionKind:
    if cyclic:
        return "CYCLE"
    kinds = {str(node.get("kind", "")) for node in members}
    edge_kinds = {str(edge.get("kind", "")) for edge in incident_edges}
    if "UNKNOWN" in edge_kinds:
        return "UNKNOWN"
    if edge_kinds & {"HTTP_BOUNDARY", "DURABLE_BOUNDARY"}:
        return "BOUNDARY"
    if "CALL_RETURN" in edge_kinds:
        return "CALL"
    if edge_kinds & {"MEMORY_MAY"}:
        return "STATE"
    if any(kind.startswith(_DECISION_PREFIXES) for kind in kinds):
        return "DECISION"
    return "TRANSFORM"


def _tarjan(
    node_ids: set[str], successors: dict[str, set[str]]
) -> list[tuple[str, ...]]:
    index = 0
    indices: dict[str, int] = {}
    lowlinks: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    result: list[tuple[str, ...]] = []

    def visit(node_id: str) -> None:
        nonlocal index
        indices[node_id] = index
        lowlinks[node_id] = index
        index += 1
        stack.append(node_id)
        on_stack.add(node_id)
        for target in sorted(successors.get(node_id, ())):
            if target not in node_ids:
                continue
            if target not in indices:
                visit(target)
                lowlinks[node_id] = min(
                    lowlinks[node_id], lowlinks[target]
                )
            elif target in on_stack:
                lowlinks[node_id] = min(
                    lowlinks[node_id], indices[target]
                )
        if lowlinks[node_id] != indices[node_id]:
            return
        members: list[str] = []
        while stack:
            member = stack.pop()
            on_stack.remove(member)
            members.append(member)
            if member == node_id:
                break
        result.append(tuple(sorted(members)))

    for node_id in sorted(node_ids):
        if node_id not in indices:
            visit(node_id)
    return result


def _bundle_region_edges(
    edges: Iterable[dict[str, Any]],
    node_regions: dict[str, str],
) -> tuple[RegionEdge, ...]:
    grouped: dict[
        tuple[str, str],
        dict[str, Any],
    ] = {}
    for edge in edges:
        kind = str(edge.get("kind", "UNKNOWN"))
        if kind not in _DEPENDENCE_KINDS:
            continue
        source = node_regions.get(str(edge["source"]))
        target = node_regions.get(str(edge["target"]))
        if source is None or target is None or source == target:
            continue
        group = grouped.setdefault(
            (source, target),
            {"kinds": set(), "paths": set(), "certainties": [], "count": 0},
        )
        group["kinds"].add(kind)
        if edge.get("variable"):
            group["paths"].add(str(edge["variable"]))
        group["certainties"].append(str(edge.get("certainty", "MUST")))
        group["count"] += 1
    return tuple(
        RegionEdge(
            edge_id=_identifier(
                "redge",
                source,
                target,
                tuple(sorted(group["kinds"])),
                tuple(sorted(group["paths"])),
            ),
            source_region_id=source,
            target_region_id=target,
            edge_kinds=tuple(sorted(group["kinds"])),  # type: ignore[arg-type]
            variable_paths=tuple(sorted(group["paths"])),
            certainty=_certainty(group["certainties"]),  # type: ignore[arg-type]
            supporting_edge_count=int(group["count"]),
        )
        for (source, target), group in sorted(grouped.items())
    )


def build_statement_projection(
    nodes: Iterable[dict[str, Any]],
    edges: Iterable[dict[str, Any]],
    *,
    focus_node_ids: Iterable[str] = (),
) -> GraphProjection:
    values = list(nodes)
    edge_values = list(edges)
    regions: list[DependenceRegion] = []
    node_regions: dict[str, str] = {}
    for node in sorted(
        values,
        key=lambda value: (
            str(value.get("file", "")),
            int(value.get("line", 0)),
            str(value["node_id"]),
        ),
    ):
        node_id = str(node["node_id"])
        region_id = _identifier("stmt", node_id)
        node_regions[node_id] = region_id
        regions.append(
            DependenceRegion(
                region_id=region_id,
                level="STATEMENT",
                kind=_region_kind([node], [], cyclic=False),
                label=(
                    f"{node.get('file', '?')}:{node.get('line', '?')} "
                    f"{node.get('kind', 'statement')}"
                ),
                member_node_ids=(node_id,),
                member_function_ids=(str(node.get("function_id", "")),),
                input_paths=tuple(sorted(set(node.get("uses", ())))),
                output_paths=tuple(sorted(set(node.get("defs", ())))),
                entry_node_ids=(node_id,),
                exit_node_ids=(node_id,),
                child_region_ids=(),
                expansion_state="EXPANDED",
            )
        )
    focus = tuple(
        node_regions[node_id]
        for node_id in focus_node_ids
        if node_id in node_regions
    )
    return GraphProjection(
        level="STATEMENT",
        regions=tuple(regions),
        edges=_bundle_region_edges(edge_values, node_regions),
        focus_region_ids=focus,
    )


def build_segment_projection(
    nodes: Iterable[dict[str, Any]],
    edges: Iterable[dict[str, Any]],
    *,
    manifestation_node_id: str | None = None,
    cut_node_ids: Iterable[str] = (),
    focus_node_ids: Iterable[str] = (),
) -> GraphProjection:
    values = list(nodes)
    edge_values = [
        edge
        for edge in edges
        if str(edge.get("kind", "")) in _DEPENDENCE_KINDS
    ]
    nodes_by_id = {str(node["node_id"]): node for node in values}
    by_function: dict[str, set[str]] = defaultdict(set)
    for node in values:
        by_function[str(node.get("function_id", ""))].add(
            str(node["node_id"])
        )
    forced_cuts = set(cut_node_ids)
    if manifestation_node_id:
        forced_cuts.add(manifestation_node_id)

    all_regions: list[DependenceRegion] = []
    node_regions: dict[str, str] = {}
    for function_id, function_nodes in sorted(by_function.items()):
        local_edges = [
            edge
            for edge in edge_values
            if str(edge["source"]) in function_nodes
            and str(edge["target"]) in function_nodes
        ]
        successors: dict[str, set[str]] = defaultdict(set)
        for edge in local_edges:
            successors[str(edge["source"])].add(str(edge["target"]))
        sccs = _tarjan(function_nodes, successors)
        scc_by_node = {
            node_id: index
            for index, members in enumerate(sccs)
            for node_id in members
        }
        scc_successors: dict[int, set[int]] = defaultdict(set)
        scc_predecessors: dict[int, set[int]] = defaultdict(set)
        incident_by_scc: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for edge in local_edges:
            source = scc_by_node[str(edge["source"])]
            target = scc_by_node[str(edge["target"])]
            incident_by_scc[source].append(edge)
            incident_by_scc[target].append(edge)
            if source != target:
                scc_successors[source].add(target)
                scc_predecessors[target].add(source)

        hard: set[int] = set()
        for index, members in enumerate(sccs):
            member_values = [nodes_by_id[node_id] for node_id in members]
            incident = incident_by_scc.get(index, [])
            decision = any(
                str(node.get("kind", "")).startswith(_DECISION_PREFIXES)
                for node in member_values
            )
            synthetic_terminal = any(
                str(node.get("kind", "")) in {"entry", "exit", "Return"}
                for node in member_values
            )
            uncertain = any(
                str(edge.get("certainty", "MUST")) != "MUST"
                or str(edge.get("kind", ""))
                in {"MEMORY_MAY", "UNKNOWN", "HTTP_BOUNDARY", "DURABLE_BOUNDARY"}
                for edge in incident
            )
            if (
                len(members) > 1
                or any(node_id in forced_cuts for node_id in members)
                or decision
                or synthetic_terminal
                or uncertain
                or len(scc_predecessors.get(index, ())) != 1
                or len(scc_successors.get(index, ())) != 1
            ):
                hard.add(index)

        groups: list[set[int]] = [{index} for index in sorted(hard)]
        remaining = set(range(len(sccs))) - hard
        while remaining:
            seed = min(remaining)
            group = {seed}
            queue = [seed]
            remaining.remove(seed)
            while queue:
                current = queue.pop()
                neighbors = (
                    scc_successors.get(current, set())
                    | scc_predecessors.get(current, set())
                )
                for neighbor in sorted(neighbors):
                    if neighbor not in remaining:
                        continue
                    remaining.remove(neighbor)
                    group.add(neighbor)
                    queue.append(neighbor)
            groups.append(group)

        for group in groups:
            member_ids = sorted(
                (
                    node_id
                    for scc_index in group
                    for node_id in sccs[scc_index]
                ),
                key=lambda node_id: (
                    int(nodes_by_id[node_id].get("line", 0)),
                    node_id,
                ),
            )
            member_set = set(member_ids)
            members = [nodes_by_id[node_id] for node_id in member_ids]
            incident = [
                edge
                for edge in edge_values
                if str(edge["source"]) in member_set
                or str(edge["target"]) in member_set
            ]
            incoming = [
                edge
                for edge in incident
                if str(edge["target"]) in member_set
                and str(edge["source"]) not in member_set
            ]
            outgoing = [
                edge
                for edge in incident
                if str(edge["source"]) in member_set
                and str(edge["target"]) not in member_set
            ]
            internally_defined = {
                str(path)
                for node in members
                for path in node.get("defs", ())
            }
            external_uses = {
                str(path)
                for node in members
                for path in node.get("uses", ())
                if str(path) not in internally_defined
            }
            input_paths = external_uses | {
                str(edge["variable"])
                for edge in incoming
                if edge.get("variable")
            }
            output_paths = {
                str(edge["variable"])
                for edge in outgoing
                if edge.get("variable")
            }
            if not output_paths:
                output_paths = {
                    str(path)
                    for node in members
                    for path in node.get("defs", ())
                }
            control_paths = {
                str(path)
                for node in members
                if str(node.get("kind", "")).startswith(_DECISION_PREFIXES)
                for path in node.get("uses", ())
            }
            entry_ids = tuple(
                node_id
                for node_id in member_ids
                if not any(
                    str(edge["target"]) == node_id
                    and str(edge["source"]) in member_set
                    for edge in incident
                )
            ) or (member_ids[0],)
            exit_ids = tuple(
                node_id
                for node_id in member_ids
                if not any(
                    str(edge["source"]) == node_id
                    and str(edge["target"]) in member_set
                    for edge in incident
                )
            ) or (member_ids[-1],)
            region_id = _identifier("seg", function_id, tuple(member_ids))
            for node_id in member_ids:
                node_regions[node_id] = region_id
            first = members[0]
            last = members[-1]
            label = (
                f"{first.get('file', '?')}:{first.get('line', '?')}"
                if first is last
                else (
                    f"{first.get('file', '?')}:{first.get('line', '?')}"
                    f"-{last.get('end_line', last.get('line', '?'))}"
                )
            )
            all_regions.append(
                DependenceRegion(
                    region_id=region_id,
                    level="SEGMENT",
                    kind=_region_kind(
                        members,
                        incident,
                        cyclic=any(len(sccs[index]) > 1 for index in group),
                    ),
                    label=label,
                    member_node_ids=tuple(member_ids),
                    member_function_ids=(function_id,),
                    input_paths=tuple(sorted(input_paths)),
                    output_paths=tuple(sorted(output_paths)),
                    control_paths=tuple(sorted(control_paths)),
                    entry_node_ids=entry_ids,
                    exit_node_ids=exit_ids,
                    certainty=_certainty(
                        str(edge.get("certainty", "MUST"))
                        for edge in incident
                    ),  # type: ignore[arg-type]
                    boundary_refs=tuple(
                        sorted(
                            {
                                str(edge.get("detail"))
                                for edge in incident
                                if edge.get("detail")
                                and str(edge.get("kind"))
                                in {"HTTP_BOUNDARY", "DURABLE_BOUNDARY"}
                            }
                        )
                    ),
                    child_region_ids=tuple(
                        _identifier("stmt", node_id) for node_id in member_ids
                    ),
                    expansion_state="COLLAPSED",
                )
            )

    focus = tuple(
        dict.fromkeys(
            node_regions[node_id]
            for node_id in focus_node_ids
            if node_id in node_regions
        )
    )
    return GraphProjection(
        level="SEGMENT",
        regions=tuple(
            sorted(all_regions, key=lambda region: region.region_id)
        ),
        edges=_bundle_region_edges(edge_values, node_regions),
        focus_region_ids=focus,
    )


def build_function_projection(
    nodes: Iterable[dict[str, Any]],
    edges: Iterable[dict[str, Any]],
    collapsed_functions: Iterable[dict[str, Any]],
    branches: Iterable[dict[str, Any]],
    segment_projection: GraphProjection,
    *,
    focus_node_ids: Iterable[str] = (),
) -> GraphProjection:
    values = list(nodes)
    edge_values = list(edges)
    by_function: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in values:
        by_function[str(node.get("function_id", ""))].append(node)
    summaries = {
        str(summary["functionId"]): summary
        for summary in collapsed_functions
    }
    segment_children: dict[str, list[str]] = defaultdict(list)
    for region in segment_projection.regions:
        for function_id in region.member_function_ids:
            segment_children[function_id].append(region.region_id)

    function_regions: dict[str, DependenceRegion] = {}
    function_region_ids: dict[str, str] = {}
    all_function_ids = set(by_function) | set(summaries)
    for function_id in sorted(all_function_ids):
        members = by_function.get(function_id, [])
        summary = summaries.get(function_id, {})
        region_id = _identifier("func", function_id)
        function_region_ids[function_id] = region_id
        input_paths = {
            str(path)
            for node in members
            for path in node.get("uses", ())
        }
        output_paths = {
            str(path)
            for node in members
            for path in node.get("defs", ())
        }
        for dependency in summary.get("dependencies", ()):
            input_paths.update(
                str(path) for path in dependency.get("input_paths", ())
            )
            output_paths.add(str(dependency.get("output_path", "return")))
        label = str(
            summary.get("qualifiedName")
            or (
                function_id.rsplit(":", 1)[-1]
                if function_id
                else "function"
            )
        )
        function_regions[function_id] = DependenceRegion(
            region_id=region_id,
            level="FUNCTION",
            kind="FUNCTION",
            label=label,
            member_node_ids=tuple(
                sorted(str(node["node_id"]) for node in members)
            ),
            member_function_ids=(function_id,),
            input_paths=tuple(sorted(input_paths)),
            output_paths=tuple(sorted(output_paths)),
            coverage_notes=tuple(summary.get("coverageNotes", ())),
            child_region_ids=tuple(sorted(segment_children.get(function_id, ()))),
            expansion_state="EXPANDED" if members else "COLLAPSED",
        )

    node_regions = {
        str(node["node_id"]): function_region_ids[
            str(node.get("function_id", ""))
        ]
        for node in values
    }
    result_edges = list(_bundle_region_edges(edge_values, node_regions))
    edge_keys = {
        (edge.source_region_id, edge.target_region_id, edge.edge_kinds)
        for edge in result_edges
    }
    frontier: list[str] = []
    for branch in branches:
        public = branch.get("public", {})
        meta = branch.get("meta", {})
        if (
            branch.get("status") != "AVAILABLE"
            or public.get("kind") != "FOLLOW_PATH"
        ):
            continue
        producer = function_region_ids.get(
            str(meta.get("targetFunctionId", ""))
        )
        consumer = node_regions.get(str(meta.get("viaNode", "")))
        if producer is None or consumer is None:
            continue
        frontier.append(producer)
        boundary = meta.get("boundaryKind")
        kind: EdgeKind = (
            "HTTP_BOUNDARY"
            if boundary == "http"
            else "DURABLE_BOUNDARY"
            if boundary == "durable"
            else "CALL_RETURN"
        )
        key = (producer, consumer, (kind,))
        if key in edge_keys:
            continue
        edge_keys.add(key)
        result_edges.append(
            RegionEdge(
                edge_id=_identifier("redge", producer, consumer, kind),
                source_region_id=producer,
                target_region_id=consumer,
                edge_kinds=(kind,),
                variable_paths=tuple(
                    sorted(str(path) for path in public.get("tracked_paths", ()))
                ),
                certainty="MAY" if boundary == "durable" else "MUST",
            )
        )
    focus_functions = {
        str(node.get("function_id", ""))
        for node in values
        if str(node["node_id"]) in set(focus_node_ids)
    }
    return GraphProjection(
        level="FUNCTION",
        regions=tuple(
            sorted(function_regions.values(), key=lambda region: region.region_id)
        ),
        edges=tuple(sorted(result_edges, key=lambda edge: edge.edge_id)),
        focus_region_ids=tuple(
            function_region_ids[function_id]
            for function_id in sorted(focus_functions)
            if function_id in function_region_ids
        ),
        frontier_region_ids=tuple(dict.fromkeys(frontier)),
    )


def build_boundary_projection(
    function_projection: GraphProjection,
    traversals: Iterable[dict[str, Any]],
    branches: Iterable[dict[str, Any]],
    *,
    focus_traversal_ids: Iterable[str] = (),
) -> GraphProjection:
    traversal_values = list(traversals)
    branch_values = list(branches)
    traversal_by_id = {
        str(value["traversal_id"]): value for value in traversal_values
    }
    function_regions = {
        function_id: region.region_id
        for region in function_projection.regions
        for function_id in region.member_function_ids
    }
    owner_functions: dict[str, set[str]] = defaultdict(set)
    for traversal in traversal_values:
        owner = str(traversal.get("service_id", "unknown"))
        function_id = str(traversal.get("function_id", ""))
        if function_id:
            owner_functions[owner].add(function_id)
    for branch in branch_values:
        public = branch.get("public", {})
        meta = branch.get("meta", {})
        if (
            branch.get("status") != "AVAILABLE"
            or public.get("kind") != "FOLLOW_PATH"
        ):
            continue
        owner = str(meta.get("targetServiceId", "unknown"))
        function_id = str(meta.get("targetFunctionId", ""))
        if function_id:
            owner_functions[owner].add(function_id)

    owners = sorted(owner_functions)
    owner_regions = {
        owner: DependenceRegion(
            region_id=_identifier("owner", owner),
            level="BOUNDARY",
            kind="OWNER",
            label=owner,
            runtime_owner=owner,
            member_function_ids=tuple(
                sorted(owner_functions[owner])
            ),
            child_region_ids=tuple(
                sorted(
                    function_regions[function_id]
                    for function_id in owner_functions[owner]
                    if function_id in function_regions
                )
            ),
            expansion_state="PARTIAL",
        )
        for owner in owners
    }
    grouped: dict[tuple[str, str], dict[str, Any]] = {}

    def add_group(
        source_owner: str,
        target_owner: str,
        kind: EdgeKind,
        paths: Iterable[str] = (),
        certainty: str = "MUST",
    ) -> None:
        if (
            source_owner == target_owner
            or source_owner not in owner_regions
            or target_owner not in owner_regions
        ):
            return
        source = owner_regions[source_owner].region_id
        target = owner_regions[target_owner].region_id
        group = grouped.setdefault(
            (source, target),
            {"kinds": set(), "paths": set(), "certainty": [], "count": 0},
        )
        group["kinds"].add(kind)
        group["paths"].update(str(path) for path in paths if path)
        group["certainty"].append(certainty)
        group["count"] += 1

    resources: dict[str, DependenceRegion] = {}
    resource_edges: list[RegionEdge] = []

    def add_runtime_boundary(
        *,
        producer_owner: str,
        consumer_owner: str,
        boundary: str | None,
        detail: str | None,
        paths: Iterable[str] = (),
    ) -> None:
        if producer_owner == consumer_owner:
            return
        if boundary == "durable":
            resource_id = _identifier(
                "resource", "durable", detail or "unknown"
            )
            resources.setdefault(
                resource_id,
                DependenceRegion(
                    region_id=resource_id,
                    level="BOUNDARY",
                    kind="RESOURCE",
                    label=detail or "durable resource",
                    runtime_owner=resource_id,
                    boundary_refs=(detail or "durable resource",),
                ),
            )
            producer = owner_regions.get(producer_owner)
            consumer = owner_regions.get(consumer_owner)
            if producer is None or consumer is None:
                return
            resource_edges.extend(
                (
                    RegionEdge(
                        edge_id=_identifier(
                            "redge",
                            producer.region_id,
                            resource_id,
                            "durable",
                        ),
                        source_region_id=producer.region_id,
                        target_region_id=resource_id,
                        edge_kinds=("DURABLE_BOUNDARY",),
                        variable_paths=tuple(sorted(set(paths))),
                        certainty="MAY",
                    ),
                    RegionEdge(
                        edge_id=_identifier(
                            "redge",
                            resource_id,
                            consumer.region_id,
                            "durable",
                        ),
                        source_region_id=resource_id,
                        target_region_id=consumer.region_id,
                        edge_kinds=("DURABLE_BOUNDARY",),
                        variable_paths=tuple(sorted(set(paths))),
                        certainty="MAY",
                    ),
                )
            )
            return
        add_group(
            producer_owner,
            consumer_owner,
            "HTTP_BOUNDARY" if boundary == "http" else "CALL_RETURN",
            paths,
        )

    for traversal in traversal_values:
        producer_owner = str(traversal.get("service_id", "unknown"))
        for hop in traversal.get("incoming_hops", ()):
            parent = traversal_by_id.get(
                str(hop.get("parent_traversal_id", ""))
            )
            if parent is None:
                continue
            add_runtime_boundary(
                producer_owner=producer_owner,
                consumer_owner=str(parent.get("service_id", "unknown")),
                boundary=hop.get("boundary_kind"),
                detail=hop.get("boundary_detail"),
                paths=traversal.get("tracked_paths", ()),
            )

    frontier_owners: list[str] = []
    for branch in branch_values:
        public = branch.get("public", {})
        meta = branch.get("meta", {})
        if (
            branch.get("status") != "AVAILABLE"
            or public.get("kind") != "FOLLOW_PATH"
        ):
            continue
        producer_owner = str(meta.get("targetServiceId", "unknown"))
        frontier_owners.append(owner_regions[producer_owner].region_id)
        parent = traversal_by_id.get(str(meta.get("sourceTraversalId", "")))
        if parent is None:
            continue
        add_runtime_boundary(
            producer_owner=producer_owner,
            consumer_owner=str(parent.get("service_id", "unknown")),
            boundary=meta.get("boundaryKind"),
            detail=meta.get("boundaryDetail"),
            paths=meta.get("trackedPaths", ()),
        )

    edges = [
        RegionEdge(
            edge_id=_identifier(
                "redge",
                source,
                target,
                tuple(sorted(group["kinds"])),
                tuple(sorted(group["paths"])),
            ),
            source_region_id=source,
            target_region_id=target,
            edge_kinds=tuple(sorted(group["kinds"])),  # type: ignore[arg-type]
            variable_paths=tuple(sorted(group["paths"])),
            certainty=_certainty(group["certainty"]),  # type: ignore[arg-type]
            supporting_edge_count=int(group["count"]),
        )
        for (source, target), group in sorted(grouped.items())
    ]
    edges.extend(resource_edges)
    focus_owners = tuple(
        dict.fromkeys(
            owner_regions[str(traversal_by_id[traversal_id]["service_id"])].region_id
            for traversal_id in focus_traversal_ids
            if traversal_id in traversal_by_id
            and str(traversal_by_id[traversal_id]["service_id"])
            in owner_regions
        )
    )
    return GraphProjection(
        level="BOUNDARY",
        regions=tuple(
            sorted(
                [*owner_regions.values(), *resources.values()],
                key=lambda region: region.region_id,
            )
        ),
        edges=tuple(
            sorted(
                {edge.edge_id: edge for edge in edges}.values(),
                key=lambda edge: edge.edge_id,
            )
        ),
        focus_region_ids=focus_owners,
        frontier_region_ids=tuple(dict.fromkeys(frontier_owners)),
    )


def build_graph_projections(
    *,
    nodes: Iterable[dict[str, Any]],
    edges: Iterable[dict[str, Any]],
    collapsed_functions: Iterable[dict[str, Any]],
    branches: Iterable[dict[str, Any]],
    traversals: Iterable[dict[str, Any]],
    manifestation_node_id: str | None,
    focus_node_ids: Iterable[str],
    focus_traversal_ids: Iterable[str] = (),
) -> dict[str, dict[str, Any]]:
    values = list(nodes)
    edge_values = list(edges)
    branch_values = list(branches)
    cut_node_ids = {
        str(branch.get("meta", {}).get("viaNode"))
        for branch in branch_values
        if branch.get("meta", {}).get("viaNode")
    }
    statement = build_statement_projection(
        values, edge_values, focus_node_ids=focus_node_ids
    )
    segment = build_segment_projection(
        values,
        edge_values,
        manifestation_node_id=manifestation_node_id,
        cut_node_ids=cut_node_ids,
        focus_node_ids=focus_node_ids,
    )
    function = build_function_projection(
        values,
        edge_values,
        collapsed_functions,
        branch_values,
        segment,
        focus_node_ids=focus_node_ids,
    )
    boundary = build_boundary_projection(
        function,
        traversals,
        branch_values,
        focus_traversal_ids=focus_traversal_ids,
    )

    def encode(projection: GraphProjection) -> dict[str, Any]:
        return {
            "projectionVersion": _PROJECTION_VERSION,
            "level": projection.level,
            "regions": [asdict(region) for region in projection.regions],
            "edges": [asdict(edge) for edge in projection.edges],
            "focusRegionIds": list(projection.focus_region_ids),
            "frontierRegionIds": list(projection.frontier_region_ids),
        }

    return {
        "boundary": encode(boundary),
        "function": encode(function),
        "segment": encode(segment),
        "statement": encode(statement),
    }
