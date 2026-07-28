"""Demand-driven interprocedural slicing and deterministic frontier planning."""

from __future__ import annotations

import hashlib
import time
from collections import defaultdict, deque
from dataclasses import asdict, replace
from pathlib import Path
from typing import Iterable

from .cache import AnalysisCache
from .frontend import expression_paths
from .model import (
    AnalysisCriterion,
    AnalysisPlan,
    CandidateAssessment,
    FlowEdge,
    FlowNode,
    FunctionFragment,
    Hammock,
    ProbeCandidate,
)


def _identifier(prefix: str, *parts: object) -> str:
    encoded = "\0".join(str(part) for part in parts).encode()
    return f"{prefix}_{hashlib.sha256(encoded).hexdigest()[:24]}"


class ProjectGraph:
    def __init__(self, fragments: Iterable[FunctionFragment]) -> None:
        self.fragments = tuple(fragments)
        self.functions = {fragment.function_id: fragment for fragment in self.fragments}
        self.nodes: dict[str, FlowNode] = {}
        self.edges: list[FlowEdge] = []
        self.incoming: dict[str, list[FlowEdge]] = defaultdict(list)
        self.outgoing: dict[str, list[FlowEdge]] = defaultdict(list)
        self.hammocks: dict[str, Hammock] = {}
        self.node_hammocks: dict[str, list[Hammock]] = defaultdict(list)
        self.external_input_nodes: set[str] = set()
        self.calls_by_target: dict[str, list[tuple[FunctionFragment, object]]] = (
            defaultdict(list)
        )
        for fragment in self.fragments:
            self.nodes.update({node.node_id: node for node in fragment.nodes})
            for hammock in fragment.hammocks:
                self.hammocks[hammock.hammock_id] = hammock
                for node_id in hammock.node_ids:
                    self.node_hammocks[node_id].append(hammock)
            for edge in fragment.edges:
                self.add_edge(edge)
            for call in fragment.calls:
                self.calls_by_target[call.target].append((fragment, call))
                if (
                    call.boundary_kind in {"http", "durable"}
                    and call.result_paths
                ):
                    self.external_input_nodes.add(call.node_id)
        self._compose_calls()
        self._compose_http_boundaries()
        self._compose_durable_boundaries()
        self._compose_module_memory()

    def add_edge(self, edge: FlowEdge) -> None:
        key = (
            edge.source,
            edge.target,
            edge.kind,
            edge.variable,
            edge.detail,
        )
        if any(
            (
                existing.source,
                existing.target,
                existing.kind,
                existing.variable,
                existing.detail,
            )
            == key
            for existing in self.incoming.get(edge.target, ())
        ):
            return
        self.edges.append(edge)
        self.incoming[edge.target].append(edge)
        self.outgoing[edge.source].append(edge)

    def _compose_calls(self) -> None:
        by_name: dict[str, list[FunctionFragment]] = defaultdict(list)
        for fragment in self.fragments:
            by_name[fragment.qualified_name].append(fragment)
            by_name[fragment.qualified_name.rsplit(".", 1)[-1]].append(fragment)
        for caller in self.fragments:
            for call in caller.calls:
                if call.boundary_kind != "local":
                    continue
                short = call.target.rsplit(".", 1)[-1]
                if call.target.startswith("self."):
                    owner = caller.qualified_name.rsplit(".", 1)[0]
                    candidates = by_name.get(f"{owner}.{short}", [])
                elif "." in call.target:
                    candidates = by_name.get(call.target, [])
                else:
                    candidates = by_name.get(short, [])
                unique = {candidate.function_id: candidate for candidate in candidates}
                certainty = "MUST" if len(unique) == 1 else "MAY"
                for callee in unique.values():
                    parameters = callee.parameters
                    if (
                        call.target.startswith(("self.", "cls."))
                        and parameters
                        and parameters[0] in {"self", "cls"}
                    ):
                        parameters = parameters[1:]
                    for index, parameter in enumerate(parameters):
                        if index >= len(call.argument_paths):
                            break
                        for argument in call.argument_paths[index]:
                            self.add_edge(
                                FlowEdge(
                                    source=call.node_id,
                                    target=callee.entry_node,
                                    kind="CALL_RETURN",
                                    variable=f"{argument}->{parameter}",
                                    certainty=certainty,
                                    detail="argument to parameter",
                                )
                            )
                    return_nodes = [
                        node
                        for node in callee.nodes
                        if node.kind == "Return"
                    ]
                    for result_path in call.result_paths:
                        for return_node in return_nodes:
                            self.add_edge(
                                FlowEdge(
                                    source=return_node.node_id,
                                    target=call.node_id,
                                    kind="CALL_RETURN",
                                    variable=result_path,
                                    certainty=certainty,
                                    detail="return to call result",
                                )
                            )
                if not unique and call.boundary_kind == "unknown":
                    self.add_edge(
                        FlowEdge(
                            source=caller.entry_node,
                            target=call.node_id,
                            kind="UNKNOWN",
                            certainty="UNKNOWN",
                            detail=f"unresolved call target {call.target}",
                        )
                    )

    def _compose_durable_boundaries(self) -> None:
        reads = []
        writes = []
        for fragment in self.fragments:
            for access in fragment.durable_accesses:
                if access.operation == "read":
                    reads.append(access)
                elif access.operation == "write":
                    writes.append(access)
        for write in writes:
            for read in reads:
                shared_fields = set(write.fields) & set(read.fields)
                if write.resource != read.resource or not shared_fields:
                    continue
                keys = set(write.key_fields) & set(read.key_fields)
                self.add_edge(
                    FlowEdge(
                        source=write.node_id,
                        target=read.node_id,
                        kind="DURABLE_BOUNDARY",
                        variable=",".join(sorted(shared_fields)),
                        certainty="MAY",
                        detail=(
                            f"{write.resource}; keys="
                            f"{','.join(sorted(keys)) or '<unresolved>'}"
                        ),
                    )
                )

    def _compose_http_boundaries(self) -> None:
        routes = [
            (fragment, route)
            for fragment in self.fragments
            for route in fragment.routes
        ]
        for caller in self.fragments:
            for call in caller.calls:
                if call.boundary_kind != "http":
                    continue
                method = call.target.rsplit(".", 1)[-1].upper()
                detail = call.boundary_detail or ""
                matches = [
                    (callee, route)
                    for callee, route in routes
                    if route.method == method and route.path in detail
                ]
                if matches:
                    longest = max(len(route.path) for _, route in matches)
                    matches = [
                        pair for pair in matches if len(pair[1].path) == longest
                    ]
                certainty = "MUST" if len(matches) == 1 else "MAY"
                for callee, route in matches:
                    self.add_edge(
                        FlowEdge(
                            source=call.node_id,
                            target=callee.entry_node,
                            kind="HTTP_BOUNDARY",
                            variable="request",
                            certainty=certainty,
                            detail=f"{method} {route.path}: request",
                        )
                    )
                    for return_node in callee.nodes:
                        if return_node.kind != "Return":
                            continue
                        self.add_edge(
                            FlowEdge(
                                source=return_node.node_id,
                                target=call.node_id,
                                kind="HTTP_BOUNDARY",
                                variable="response",
                                certainty=certainty,
                                detail=f"{method} {route.path}: response",
                            )
                        )

    def _compose_module_memory(self) -> None:
        by_file: dict[str, list[FunctionFragment]] = defaultdict(list)
        for fragment in self.fragments:
            by_file[fragment.file].append(fragment)
        for file, fragments in by_file.items():
            shared = {
                name
                for fragment in fragments
                for name in fragment.module_globals
            }
            for name in shared:
                writers = [
                    node
                    for fragment in fragments
                    for node in fragment.nodes
                    if any(
                        definition == name
                        or definition.startswith(name + ".")
                        for definition in node.defs
                    )
                ]
                readers = [
                    node
                    for fragment in fragments
                    for node in fragment.nodes
                    if any(
                        use == name or use.startswith(name + ".")
                        for use in node.uses
                    )
                ]
                for writer in writers:
                    for reader in readers:
                        if (
                            writer.function_id == reader.function_id
                            or writer.node_id == reader.node_id
                        ):
                            continue
                        self.add_edge(
                            FlowEdge(
                                source=writer.node_id,
                                target=reader.node_id,
                                kind="MEMORY_MAY",
                                variable=name,
                                certainty="MAY",
                                detail=(
                                    f"module-shared state {file}:{name} "
                                    "may flow across function executions"
                                ),
                            )
                        )

    def node_at(self, file: str, line: int) -> FlowNode:
        candidates = [
            node
            for node in self.nodes.values()
            if node.file == file
            and not node.synthetic
            and node.line <= line <= node.end_line
        ]
        if not candidates:
            raise ValueError(f"no analyzed Python statement at {file}:{line}")
        return min(
            candidates,
            key=lambda node: (
                node.end_line - node.line,
                abs(node.line - line),
            ),
        )

    def smallest_hammock(self, node_id: str) -> Hammock:
        values = self.node_hammocks.get(node_id, [])
        if not values:
            node = self.nodes[node_id]
            raise ValueError(f"node {node.file}:{node.line} has no hammock")
        return min(values, key=lambda value: len(value.node_ids))


class AnalysisEngine:
    def __init__(self, repository_root: str, cache_path: str | None = None) -> None:
        self.root = Path(repository_root).resolve()
        self.cache_path = Path(cache_path).resolve() if cache_path else None

    def prepare(self, commit: str) -> dict[str, int | float | str]:
        with AnalysisCache(self.root, self.cache_path) as cache:
            return cache.prepare(commit)

    def get_plan(self, plan_id: str) -> AnalysisPlan:
        with AnalysisCache(self.root, self.cache_path) as cache:
            return self._plan_from_dict(cache.load_plan(plan_id))

    def analyze(self, criterion: AnalysisCriterion) -> AnalysisPlan:
        started = time.perf_counter()
        with AnalysisCache(self.root, self.cache_path) as cache:
            fragments = cache.load_fragments(criterion.commit)
            source_roots = criterion.source_roots or self._default_source_roots(
                criterion.file
            )
            if source_roots:
                fragments = [
                    fragment
                    for fragment in fragments
                    if any(
                        fragment.file == root.rstrip("/")
                        or fragment.file.startswith(root.rstrip("/") + "/")
                        for root in source_roots
                    )
                ]
            graph = ProjectGraph(fragments)
            sink = graph.node_at(criterion.file, criterion.line)
            tracked_paths = (
                (criterion.watch_path,)
                if criterion.watch_path
                else (
                    expression_paths(criterion.expression)
                    if criterion.expression
                    else ()
                )
            )
            slice_nodes, slice_edges, distance = self._backward_slice(
                graph, sink, tracked_paths
            )
            hammocks = self._slice_hammocks(graph, slice_nodes)
            coverage = self._coverage(graph, slice_nodes)
            frontier = self._frontier(
                graph,
                sink.node_id,
                slice_nodes,
                slice_edges,
                distance,
                criterion.probe_budget,
                excluded=set(),
            )
            plan_id = _identifier(
                "inv",
                criterion.commit,
                criterion.service_id,
                criterion.file,
                criterion.line,
                criterion.watch_path,
                time.time_ns(),
            )
            status = "ACTIVE" if frontier else "INSUFFICIENT"
            plan = AnalysisPlan(
                plan_id=plan_id,
                criterion=criterion,
                slice_node_ids=tuple(sorted(slice_nodes)),
                slice_edges=tuple(slice_edges),
                hammocks=tuple(hammocks),
                frontier=tuple(frontier),
                coverage_notes=tuple(sorted(coverage)),
                status=status,
                stats={
                    "functionsLoaded": len(fragments),
                    "sliceNodes": len(slice_nodes),
                    "sliceEdges": len(slice_edges),
                    "hammocks": len(hammocks),
                    "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
                },
            )
            cache.save_plan(plan.plan_id, plan.to_dict())
            return plan

    def refine(
        self,
        plan_id: str,
        assessments: Iterable[CandidateAssessment],
    ) -> AnalysisPlan:
        with AnalysisCache(self.root, self.cache_path) as cache:
            raw = cache.load_plan(plan_id)
            plan = self._plan_from_dict(raw)
            fragments = cache.load_fragments(plan.criterion.commit)
            source_roots = (
                plan.criterion.source_roots
                or self._default_source_roots(plan.criterion.file)
            )
            if source_roots:
                fragments = [
                    fragment
                    for fragment in fragments
                    if any(
                        fragment.file == root.rstrip("/")
                        or fragment.file.startswith(root.rstrip("/") + "/")
                        for root in source_roots
                    )
                ]
            graph = ProjectGraph(fragments)
            by_candidate = {item.candidate_id: item for item in plan.frontier}
            bad_nodes: set[str] = set()
            good_nodes: set[str] = set()
            assessed: set[str] = set()
            for assessment in assessments:
                candidate = by_candidate.get(assessment.candidate_id)
                if candidate is None:
                    raise ValueError(
                        f"candidate {assessment.candidate_id} is not in plan frontier"
                    )
                assessed.add(candidate.candidate_id)
                hammock = graph.hammocks[candidate.hammock_id]
                target = self._candidate_node(graph, candidate)
                if assessment.classification == "bad":
                    bad_nodes.add(target.node_id)
                elif assessment.classification == "good":
                    good_nodes.add(target.node_id)

            retained = set(plan.slice_node_ids)
            if bad_nodes:
                retained = self._ancestors(graph, bad_nodes) | bad_nodes
            elif good_nodes:
                # With no bad observation, good evidence moves the search
                # downstream. If bad evidence exists, preserve its ancestors:
                # a path-insensitive good candidate may observe a sibling value
                # and must not erase a shared bad origin.
                before_good = self._ancestors(graph, good_nodes)
                retained -= before_good - good_nodes
            retained.add(
                graph.node_at(plan.criterion.file, plan.criterion.line).node_id
            )

            likely_hammock: str | None = None
            external_bad = sorted(bad_nodes & graph.external_input_nodes)
            if external_bad:
                likely_hammock = graph.smallest_hammock(
                    external_bad[0]
                ).hammock_id
            for bad in bad_nodes:
                if likely_hammock is not None:
                    break
                incoming_data = [
                    edge
                    for edge in graph.incoming.get(bad, [])
                    if edge.kind in {"DATA", "CALL_RETURN", "DURABLE_BOUNDARY"}
                ]
                if incoming_data and all(edge.source in good_nodes for edge in incoming_data):
                    likely_hammock = graph.smallest_hammock(bad).hammock_id
                    break

            status = (
                "EXONERATED"
                if external_bad
                else "LOCALIZED"
                if likely_hammock
                else "ACTIVE"
            )
            sink = graph.node_at(plan.criterion.file, plan.criterion.line)
            distances = self._distances(graph, sink.node_id, retained)
            slice_edges = [
                edge
                for edge in graph.edges
                if edge.source in retained
                and edge.target in retained
                and edge.kind != "CFG"
            ]
            frontier = (
                []
                if likely_hammock
                else self._frontier(
                    graph,
                    sink.node_id,
                    retained,
                    slice_edges,
                    distances,
                    plan.criterion.probe_budget,
                    excluded={
                        candidate.function_id
                        + ":"
                        + candidate.hammock_id
                        + ":"
                        + str(candidate.line)
                        for candidate in plan.frontier
                        if candidate.candidate_id in assessed
                    },
                )
            )
            if not frontier and not likely_hammock:
                if external_bad:
                    likely_hammock = graph.smallest_hammock(
                        external_bad[0]
                    ).hammock_id
                    status = "EXONERATED"
                else:
                    status = "INSUFFICIENT"
            updated = replace(
                plan,
                slice_node_ids=tuple(sorted(retained)),
                slice_edges=tuple(slice_edges),
                hammocks=tuple(self._slice_hammocks(graph, retained)),
                frontier=tuple(frontier),
                round=plan.round + 1,
                status=status,  # type: ignore[arg-type]
                likely_hammock_id=likely_hammock,
            )
            cache.save_plan(plan_id, updated.to_dict())
            return updated

    def _backward_slice(
        self,
        graph: ProjectGraph,
        sink: FlowNode,
        tracked_paths: tuple[str, ...],
    ) -> tuple[set[str], list[FlowEdge], dict[str, int]]:
        allowed = {
            "DATA",
            "CONTROL",
            "CALL_RETURN",
            "HTTP_BOUNDARY",
            "DURABLE_BOUNDARY",
            "MEMORY_MAY",
            "UNKNOWN",
        }
        for tracked in tracked_paths:
            sink_paths = set(sink.defs) | set(sink.uses)
            if any(self._path_matches(tracked, path) for path in sink_paths):
                continue
            definitions = self._reaching_definitions_at(
                graph, sink.node_id, tracked
            )
            certainty = "MUST" if len(definitions) == 1 else "MAY"
            for definition in definitions:
                graph.add_edge(
                    FlowEdge(
                        source=definition,
                        target=sink.node_id,
                        kind="DATA",
                        variable=tracked,
                        certainty=certainty,
                        detail="value referenced by manifestation expression",
                    )
                )
        initial_paths: tuple[str | None, ...] = tracked_paths or (None,)
        queue = deque((sink.node_id, path, 0) for path in initial_paths)
        seen_states = {(sink.node_id, path) for path in initial_paths}
        seen = {sink.node_id}
        distances = {sink.node_id: 0}
        edges: list[FlowEdge] = []
        edge_keys: set[tuple[str, str, str, str | None]] = set()
        while queue:
            node_id, tracked, distance = queue.popleft()
            node = graph.nodes[node_id]
            allowed_uses: set[str] | None = None
            if tracked:
                matching_pairs = [
                    (definition, dependencies)
                    for definition, dependencies in node.dependencies
                    if self._path_matches(tracked, definition)
                ]
                exact_pairs = [
                    pair for pair in matching_pairs if pair[0] == tracked
                ]
                if exact_pairs:
                    matching_pairs = exact_pairs
                elif matching_pairs:
                    longest = max(len(pair[0]) for pair in matching_pairs)
                    matching_pairs = [
                        pair for pair in matching_pairs if len(pair[0]) == longest
                    ]
                if matching_pairs:
                    allowed_uses = {
                        dependency
                        for _, dependencies in matching_pairs
                        for dependency in dependencies
                    }
            for edge in graph.incoming.get(node_id, []):
                if edge.kind not in allowed:
                    continue
                next_tracked = edge.variable
                if edge.kind == "CALL_RETURN" and edge.variable:
                    if edge.detail == "argument to parameter":
                        argument, _, parameter = edge.variable.partition("->")
                        if tracked and parameter and not self._path_matches(
                            tracked, parameter
                        ):
                            continue
                        next_tracked = argument
                    elif (
                        edge.detail == "return to call result"
                        and tracked
                        and not any(
                            self._path_matches(tracked, definition)
                            for definition in node.defs
                        )
                    ):
                        continue
                if (
                    edge.kind == "HTTP_BOUNDARY"
                    and edge.detail
                    and edge.detail.endswith(": response")
                    and tracked
                    and tracked != "response"
                    and not any(
                        self._path_matches(tracked, definition)
                        for definition in node.defs
                    )
                ):
                    continue
                if edge.kind == "DATA" and edge.variable:
                    if allowed_uses is not None and not any(
                        self._path_matches(edge.variable, dependency)
                        for dependency in allowed_uses
                    ):
                        continue
                    if (
                        allowed_uses is None
                        and tracked
                        and not self._path_matches(edge.variable, tracked)
                    ):
                        continue
                elif (
                    edge.kind == "MEMORY_MAY"
                    and edge.variable
                    and (
                        allowed_uses is not None
                        or tracked is not None
                    )
                    and not any(
                        self._path_matches(part.strip(), desired)
                        for part in edge.variable.split(",")
                        for desired in (
                            allowed_uses
                            if allowed_uses is not None
                            else {tracked}
                        )
                        if desired is not None
                    )
                ):
                    continue
                edge_key = (edge.source, edge.target, edge.kind, edge.variable)
                if edge_key not in edge_keys:
                    edge_keys.add(edge_key)
                    edges.append(edge)
                state = (edge.source, next_tracked)
                if state not in seen_states:
                    seen_states.add(state)
                    seen.add(edge.source)
                    distances[edge.source] = min(
                        distances.get(edge.source, distance + 1), distance + 1
                    )
                    queue.append((edge.source, next_tracked, distance + 1))
        return seen, edges, distances

    def _reaching_definitions_at(
        self,
        graph: ProjectGraph,
        node_id: str,
        variable: str,
    ) -> set[str]:
        function_id = graph.nodes[node_id].function_id
        result: set[str] = set()
        seen = {node_id}
        queue = deque(
            edge.source
            for edge in graph.incoming.get(node_id, [])
            if edge.kind == "CFG"
        )
        while queue:
            current = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            node = graph.nodes[current]
            if node.function_id != function_id:
                continue
            if any(
                self._path_matches(variable, definition)
                for definition in node.defs
            ):
                result.add(current)
                continue
            queue.extend(
                edge.source
                for edge in graph.incoming.get(current, [])
                if edge.kind == "CFG"
            )
        return result

    def _path_matches(self, left: str, right: str) -> bool:
        left = left.split("->", 1)[0]
        right = right.split("->", 1)[0]
        return (
            left == right
            or left.startswith(right + ".")
            or right.startswith(left + ".")
        )

    def _slice_hammocks(
        self, graph: ProjectGraph, node_ids: set[str]
    ) -> list[Hammock]:
        values = {
            hammock.hammock_id: hammock
            for node_id in node_ids
            for hammock in graph.node_hammocks.get(node_id, [])
        }
        return sorted(
            values.values(),
            key=lambda value: (value.start_line, value.end_line, value.hammock_id),
        )

    def _coverage(self, graph: ProjectGraph, node_ids: set[str]) -> set[str]:
        result: set[str] = set()
        function_ids = {graph.nodes[node_id].function_id for node_id in node_ids}
        for function_id in function_ids:
            result.update(graph.functions[function_id].coverage_notes)
        for edge in graph.edges:
            if edge.target in node_ids and edge.kind == "UNKNOWN" and edge.detail:
                result.add(edge.detail)
        return result

    def _frontier(
        self,
        graph: ProjectGraph,
        sink_id: str,
        nodes: set[str],
        edges: Iterable[FlowEdge],
        distances: dict[str, int],
        budget: int,
        excluded: set[str],
    ) -> list[ProbeCandidate]:
        outgoing_count: dict[str, int] = defaultdict(int)
        uncertainty: dict[str, int] = defaultdict(int)
        boundary: dict[str, int] = defaultdict(int)
        for edge in edges:
            outgoing_count[edge.source] += 1
            if edge.certainty != "MUST":
                uncertainty[edge.source] += 1
                uncertainty[edge.target] += 1
            if edge.kind in {
                "HTTP_BOUNDARY",
                "DURABLE_BOUNDARY",
                "MEMORY_MAY",
            }:
                boundary[edge.source] += 1
                boundary[edge.target] += 1
        scored: list[
            tuple[FlowNode, Hammock, int, int, int, int]
        ] = []
        for node_id in nodes:
            node = graph.nodes[node_id]
            if node.synthetic or node.probe_line is None or node_id == sink_id:
                continue
            watch_paths = tuple(
                path
                for path in sorted(set(node.defs or node.uses))
                if not path.startswith("$")
            )
            if not watch_paths:
                continue
            hammock = graph.smallest_hammock(node_id)
            exclusion_key = (
                node.function_id
                + ":"
                + hammock.hammock_id
                + ":"
                + str(node.probe_line)
            )
            if exclusion_key in excluded:
                continue
            distance = distances.get(node_id, 0)
            upstream = len(self._ancestors(graph, {node_id}) & nodes)
            scored.append(
                (
                    node,
                    hammock,
                    distance,
                    upstream,
                    uncertainty[node_id]
                    + (2 if node.kind.endswith(":conditional") else 0),
                    boundary[node_id],
                )
            )
        result: list[ProbeCandidate] = []
        used_locations: set[tuple[str, int]] = set()

        def add(
            item: tuple[FlowNode, Hammock, int, int, int, int],
            reason: str,
        ) -> None:
            node, hammock, distance, upstream, uncertain, _ = item
            assert node.probe_line is not None
            location = (node.file, node.probe_line)
            if location in used_locations or len(result) >= max(
                1, min(budget, 10)
            ):
                return
            used_locations.add(location)
            watch_paths = tuple(
                path
                for path in sorted(set(node.defs or node.uses))
                if not path.startswith("$")
            )[:10]
            result.append(
                ProbeCandidate(
                    candidate_id=_identifier(
                        "cand", node.node_id, node.probe_line, watch_paths
                    ),
                    function_id=node.function_id,
                    hammock_id=hammock.hammock_id,
                    file=node.file,
                    line=node.probe_line,
                    watch_paths=watch_paths,
                    distance_from_sink=distance,
                    upstream_weight=upstream,
                    reason=reason,
                    certainty="MAY" if uncertain else "MUST",
                )
            )

        boundary_quota = max(1, min(budget, 10) // 5)
        boundary_items = sorted(
            (item for item in scored if item[5] > 0),
            key=lambda item: (
                item[5],
                item[2],
                item[3],
                item[4],
            ),
            reverse=True,
        )
        for item in boundary_items:
            if len(result) >= boundary_quota:
                break
            add(item, "cross-boundary dependency cut")

        near_items = sorted(
            scored,
            key=lambda item: (
                item[2],
                -item[3],
                -item[4],
                -outgoing_count[item[0].node_id],
                item[0].file,
                item[0].line,
            ),
        )
        for item in near_items:
            if len(result) >= max(1, min(budget, 10)):
                break
            add(
                item,
                (
                    "near-manifestation dependency cut"
                    if item[2] <= 2
                    else "balanced upstream cut"
                ),
            )
        return result

    def _ancestors(self, graph: ProjectGraph, start: set[str]) -> set[str]:
        result: set[str] = set()
        queue = deque(start)
        while queue:
            node_id = queue.popleft()
            for edge in graph.incoming.get(node_id, []):
                if edge.kind == "CFG" or edge.source in result:
                    continue
                result.add(edge.source)
                queue.append(edge.source)
        return result

    def _distances(
        self, graph: ProjectGraph, sink: str, allowed: set[str]
    ) -> dict[str, int]:
        result = {sink: 0}
        queue = deque([sink])
        while queue:
            current = queue.popleft()
            for edge in graph.incoming.get(current, []):
                if (
                    edge.kind == "CFG"
                    or edge.source not in allowed
                    or edge.source in result
                ):
                    continue
                result[edge.source] = result[current] + 1
                queue.append(edge.source)
        return result

    def _candidate_node(
        self, graph: ProjectGraph, candidate: ProbeCandidate
    ) -> FlowNode:
        matches = [
            node
            for node in graph.nodes.values()
            if node.function_id == candidate.function_id
            and node.probe_line == candidate.line
            and not node.synthetic
        ]
        if not matches:
            raise ValueError(f"candidate {candidate.candidate_id} node not found")
        return min(matches, key=lambda node: node.line)

    def _plan_from_dict(self, raw: dict[str, object]) -> AnalysisPlan:
        criterion_raw = dict(raw["criterion"])
        criterion_raw["source_roots"] = tuple(
            criterion_raw.get("source_roots", ())
        )
        criterion = AnalysisCriterion(**criterion_raw)
        return AnalysisPlan(
            plan_id=str(raw["plan_id"]),
            criterion=criterion,
            slice_node_ids=tuple(raw["slice_node_ids"]),
            slice_edges=tuple(FlowEdge(**value) for value in raw["slice_edges"]),
            hammocks=tuple(Hammock(**value) for value in raw["hammocks"]),
            frontier=tuple(
                ProbeCandidate(**value) for value in raw["frontier"]
            ),
            coverage_notes=tuple(raw["coverage_notes"]),
            round=int(raw.get("round", 1)),
            status=raw.get("status", "ACTIVE"),  # type: ignore[arg-type]
            likely_hammock_id=raw.get("likely_hammock_id"),
            stats=dict(raw.get("stats", {})),
        )

    def _default_source_roots(self, file: str) -> tuple[str, ...]:
        if file.startswith("services/"):
            return ("services", "common")
        return ()
