"""Persistent runtime-guided investigations over a lazy Python flow graph."""

from __future__ import annotations

import hashlib
import json
import time
from collections import defaultdict, deque
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable

from .cache import AnalysisCache
from .frontend import expression_paths
from .model import (
    CandidateMechanism,
    CallSite,
    FlowEdge,
    FlowNode,
    FunctionFragment,
    FunctionSummary,
    InvestigationAction,
    InvestigationCriterion,
    InvestigationDecision,
    InvestigationProbeSite,
    ProbeBundle,
    RuntimeTraversal,
    TraversalHop,
    ValueDossier,
    ValueJudgment,
    ValueObservation,
)
from .regions import build_graph_projections

_EXPLORATION_PACKET_LIMIT_BYTES = 4 * 1024
_MECHANISM_PACKET_LIMIT_BYTES = 6 * 1024
_GRAPH_NODE_LIMIT = 60
_TRAVERSAL_VIEW_LIMIT = 24
_AUTO_EXPANSION_LIMIT = 5
_ACTIVE_ACTION_LIMIT = 6
_REGION_CANDIDATE_LIMIT = 6
_EXPLORATION_SITE_LIMIT = 5
_BLOCKING_DEPENDENCY_ROLES = {
    "VALUE_PRODUCER",
    "HISTORICAL_STATE_PRODUCER",
}
_NON_VALUE_WATCHES = {
    "abs",
    "bool",
    "dict",
    "float",
    "int",
    "isinstance",
    "len",
    "list",
    "max",
    "min",
    "round",
    "set",
    "str",
    "tuple",
}


def _identifier(prefix: str, *parts: object) -> str:
    encoded = "\0".join(str(part) for part in parts).encode()
    return f"{prefix}_{hashlib.sha256(encoded).hexdigest()[:24]}"


def _path_matches(left: str, right: str) -> bool:
    left = left.split("->", 1)[0]
    right = right.split("->", 1)[0]
    return (
        left == right
        or left.startswith(right + ".")
        or right.startswith(left + ".")
    )


def _minimal_path_antichain(paths: Iterable[str]) -> tuple[str, ...]:
    """Prefer precise leaves over expensive parent-object captures."""

    normalized = tuple(
        dict.fromkeys(
            path
            for path in paths
            if path
            and not path.startswith("$")
            and path not in _NON_VALUE_WATCHES
        )
    )
    return tuple(
        path
        for path in normalized
        if not any(
            other != path and other.startswith(path + ".")
            for other in normalized
        )
    )


def _source_root(file: str) -> str:
    parts = file.split("/")
    if len(parts) >= 2 and parts[0] == "services":
        return "/".join(parts[:2])
    return parts[0]


def _runtime_service(
    file: str,
    ownership_map: Iterable[Iterable[str]],
    fallback: str,
) -> str:
    matches = [
        (str(source_root).rstrip("/"), str(service_id))
        for source_root, service_id in ownership_map
        if file == str(source_root).rstrip("/")
        or file.startswith(str(source_root).rstrip("/") + "/")
    ]
    if not matches:
        return fallback
    return max(matches, key=lambda value: len(value[0]))[1]


def _observation_nodes(
    state: dict[str, Any],
    observation: dict[str, Any],
    *,
    include_provenance: bool = False,
) -> set[str]:
    site = state["sites"].get(observation.get("site_id"))
    if not isinstance(site, dict):
        return set()
    path_nodes = dict(site.get("path_node_ids", ()))
    nodes = {
        str(path_nodes.get(path, site["node_id"]))
        for path in observation.get("values", {})
    } or {str(site["node_id"])}
    if include_provenance:
        nodes.update(
            edge["source"]
            for edge in state.get("graph_edges", ())
            if edge["kind"] == "DATA"
            and edge["target"] in nodes
            and edge["source"] in state.get("graph_nodes", {})
        )
    return nodes


class LazyGraphStore:
    """Load summaries eagerly and function bodies only when expanded."""

    def __init__(
        self,
        cache: AnalysisCache,
        commit: str,
        source_roots: tuple[str, ...],
    ) -> None:
        self.cache = cache
        self.commit = commit
        # Source roots constrain initial focus and runtime ownership, not
        # dependency discovery. Imported helpers and upstream producers may
        # legitimately live outside those roots.
        self.summaries = cache.load_summaries(commit)
        self.by_id = {
            summary.function_id: summary for summary in self.summaries
        }
        self.by_name: dict[str, list[FunctionSummary]] = defaultdict(list)
        self.callers: dict[str, list[tuple[FunctionSummary, CallSite]]] = (
            defaultdict(list)
        )
        self.routes: list[tuple[FunctionSummary, object]] = []
        self.durable_reads: list[tuple[FunctionSummary, object]] = []
        self.durable_writes: list[tuple[FunctionSummary, object]] = []
        self.fragments: dict[str, FunctionFragment] = {}
        for summary in self.summaries:
            self.by_name[summary.qualified_name].append(summary)
            self.by_name[summary.qualified_name.rsplit(".", 1)[-1]].append(
                summary
            )
            module = summary.file.removesuffix(".py").replace("/", ".")
            self.by_name[
                f"{module}.{summary.qualified_name}"
            ].append(summary)
            for call in summary.calls:
                self.callers[call.target].append((summary, call))
                self.callers[call.target.rsplit(".", 1)[-1]].append(
                    (summary, call)
                )
            for route in summary.routes:
                self.routes.append((summary, route))
            for access in summary.durable_accesses:
                target = (
                    self.durable_reads
                    if access.operation == "read"
                    else self.durable_writes
                )
                target.append((summary, access))

    def fragment(self, function_id: str) -> FunctionFragment:
        fragment = self.fragments.get(function_id)
        if fragment is None:
            fragment = self.cache.load_fragment(self.commit, function_id)
            self.fragments[function_id] = fragment
        return fragment

    def summary_at(self, file: str, line: int) -> FunctionSummary:
        candidates = [
            summary
            for summary in self.summaries
            if summary.file == file
            and summary.start_line <= line <= summary.end_line
        ]
        if not candidates:
            return self.cache.find_summary_at(self.commit, file, line)
        return min(
            candidates,
            key=lambda value: (
                value.end_line - value.start_line,
                -value.start_line,
            ),
        )

    def resolve_callees(
        self, caller: FunctionSummary, call: CallSite
    ) -> list[FunctionSummary]:
        if call.boundary_kind != "local":
            return []
        short = call.target.rsplit(".", 1)[-1]
        if call.target.startswith("self."):
            owner = caller.qualified_name.rsplit(".", 1)[0]
            candidates = self.by_name.get(f"{owner}.{short}", [])
        elif "." in call.target:
            candidates = self.by_name.get(call.target, [])
        else:
            candidates = self.by_name.get(short, [])
        return list(
            {
                candidate.function_id: candidate for candidate in candidates
            }.values()
        )

    def resolve_http_producers(
        self, call: CallSite
    ) -> list[FunctionSummary]:
        if call.boundary_kind != "http":
            return []
        method = call.target.rsplit(".", 1)[-1].upper()
        detail = call.boundary_detail or ""
        matches = [
            (summary, route)
            for summary, route in self.routes
            if getattr(route, "method") == method
            and getattr(route, "path") in detail
        ]
        if matches:
            longest = max(len(getattr(route, "path")) for _, route in matches)
            matches = [
                pair
                for pair in matches
                if len(getattr(pair[1], "path")) == longest
            ]
        return list(
            {summary.function_id: summary for summary, _ in matches}.values()
        )

    def resolve_durable_writers(
        self, resource: str, fields: tuple[str, ...]
    ) -> list[tuple[FunctionSummary, str, tuple[str, ...]]]:
        desired = set(fields)
        result: list[tuple[FunctionSummary, str, tuple[str, ...]]] = []
        for summary, access in self.durable_writes:
            if getattr(access, "resource") != resource:
                continue
            shared = tuple(
                sorted(desired & set(getattr(access, "fields")))
            )
            if desired and not shared:
                continue
            result.append((summary, getattr(access, "node_id"), shared))
        return result

    def resolve_callers(
        self, callee: FunctionSummary
    ) -> list[tuple[FunctionSummary, CallSite]]:
        values = [
            *self.callers.get(callee.qualified_name, ()),
            *self.callers.get(callee.qualified_name.rsplit(".", 1)[-1], ()),
        ]
        unique: dict[tuple[str, str], tuple[FunctionSummary, CallSite]] = {}
        for caller, call in values:
            if any(
                candidate.function_id == callee.function_id
                for candidate in self.resolve_callees(caller, call)
            ):
                unique[(caller.function_id, call.node_id)] = (caller, call)
        return list(unique.values())


def _local_backward(
    fragment: FunctionFragment,
    anchors: tuple[str, ...],
    tracked_paths: tuple[str, ...],
) -> tuple[
    set[str],
    list[FlowEdge],
    dict[str, int],
    dict[str, set[str]],
]:
    nodes = {node.node_id: node for node in fragment.nodes}
    incoming: dict[str, list[FlowEdge]] = defaultdict(list)
    for edge in fragment.edges:
        incoming[edge.target].append(edge)
    initial = tracked_paths or (None,)
    queue = deque(
        (anchor, tracked, 0)
        for anchor in anchors
        for tracked in initial
        if anchor in nodes
    )
    states = {(anchor, tracked) for anchor, tracked, _ in queue}
    seen = {anchor for anchor, _, _ in queue}
    distances = {anchor: 0 for anchor in seen}
    tracked_by_node: dict[str, set[str]] = defaultdict(set)
    for anchor, path, _ in queue:
        if path:
            tracked_by_node[anchor].add(path)
    selected_edges: list[FlowEdge] = []
    edge_keys: set[tuple[str, str, str, str | None]] = set()
    while queue:
        node_id, tracked, distance = queue.popleft()
        node = nodes[node_id]
        allowed_uses: set[str] | None = None
        if tracked:
            pairs = [
                (definition, dependencies)
                for definition, dependencies in node.dependencies
                if _path_matches(tracked, definition)
            ]
            if pairs:
                longest = max(len(definition) for definition, _ in pairs)
                allowed_uses = {
                    dependency
                    for definition, dependencies in pairs
                    if len(definition) == longest
                    for dependency in dependencies
                }
        for edge in incoming.get(node_id, ()):
            if edge.kind not in {"DATA", "CONTROL", "MEMORY_MAY", "UNKNOWN"}:
                continue
            if edge.kind == "DATA" and edge.variable:
                wanted = allowed_uses if allowed_uses is not None else (
                    {tracked} if tracked else None
                )
                if wanted and not any(
                    _path_matches(edge.variable, value) for value in wanted
                ):
                    continue
            key = (edge.source, edge.target, edge.kind, edge.variable)
            if key not in edge_keys:
                edge_keys.add(key)
                selected_edges.append(edge)
            next_tracked = edge.variable if edge.kind == "DATA" else tracked
            state = (edge.source, next_tracked)
            if next_tracked:
                tracked_by_node[edge.source].add(next_tracked)
            if state in states:
                continue
            states.add(state)
            seen.add(edge.source)
            distances[edge.source] = min(
                distances.get(edge.source, distance + 1),
                distance + 1,
            )
            queue.append((edge.source, next_tracked, distance + 1))
    return seen, selected_edges, distances, tracked_by_node


class InvestigationEngine:
    """Build, persist, and advance reversible runtime-guided investigations."""

    def __init__(self, repository_root: str, cache_path: str | None = None) -> None:
        self.root = Path(repository_root).resolve()
        self.cache_path = Path(cache_path).resolve() if cache_path else None

    def start(self, criterion: InvestigationCriterion) -> dict[str, object]:
        started = time.perf_counter()
        with AnalysisCache(self.root, self.cache_path) as cache:
            store = LazyGraphStore(
                cache, criterion.commit, criterion.source_roots
            )
            summary = store.summary_at(criterion.file, criterion.line)
            fragment = store.fragment(summary.function_id)
            sink = self._node_at(fragment, criterion.line)
            tracked = (
                (criterion.watch_path,)
                if criterion.watch_path
                else (
                    expression_paths(criterion.expression)
                    if criterion.expression
                    else ()
                )
            )
            investigation_id = _identifier(
                "inv",
                criterion.commit,
                criterion.service_id,
                criterion.file,
                criterion.line,
                time.time_ns(),
            )
            state: dict[str, Any] = {
                "schema_version": 4,
                "investigation_id": investigation_id,
                "criterion": asdict(criterion),
                "revision": 1,
                "phase": "TRACING",
                "status": "ACTIVE",
                "round": 1,
                "manifestation_node_id": sink.node_id,
                "manifestation_traversal_id": None,
                "manifestation_site_ids": [],
                "expanded_functions": [],
                "collapsed_functions": {},
                "graph_nodes": {},
                "graph_edges": [],
                "node_distances": {},
                "node_traversal_ids": {},
                "tracked_paths_by_node": {},
                "callable_paths_by_node": {},
                "traversals": {},
                "focus_node_ids": [],
                "focus_traversal_ids": [],
                "active_focus_node_ids": [],
                "active_focus_traversal_ids": [],
                "active_action_ids": [],
                "probe_focus_node_ids": [],
                "probe_focus_traversal_ids": [],
                "probe_focus_paths_by_node": {},
                "branches": {},
                "sites": {},
                "probe_bundle": None,
                "observations": [],
                "dossiers": [],
                "dossier_keys": [],
                "judgments": [],
                "evidence_coverage": [],
                "causal_path_cache": {},
                "last_occurrence_id": None,
                "last_evidence_revision": None,
                "coverage_notes": [],
                "decision_log": [],
                "mechanism_context": None,
                "candidate_mechanism": None,
                "confirmation_started_revision": None,
                "confirmation_occurrence_id": None,
                "probed_region_ids": [],
                "stats": {
                    "summariesLoaded": len(store.summaries),
                    "fragmentsLoaded": 0,
                },
            }
            initial_traversal_id, _ = self._ensure_traversal(
                state,
                function_id=summary.function_id,
                service_id=criterion.service_id,
                anchors=(sink.node_id,),
                tracked=tracked,
                depth=0,
            )
            state["manifestation_traversal_id"] = initial_traversal_id
            self._expand(
                state,
                store,
                summary.function_id,
                (sink.node_id,),
                tracked,
                via="manifestation",
                base_distance=0,
                traversal_id=initial_traversal_id,
            )
            if criterion.failure_class == "absence":
                state["phase"] = "INSUFFICIENT"
                state["status"] = "INSUFFICIENT"
                state["coverage_notes"].append(
                    "V1 cannot infer a missing control-flow event from value "
                    "captures; counter/control probes are required"
                )
                for branch in state["branches"].values():
                    branch["status"] = "UNSUPPORTED"
                state["probe_bundle"] = asdict(
                    ProbeBundle(
                        bundle_id=_identifier(
                            "bnd", investigation_id, "absence"
                        ),
                        round=1,
                        sites=(),
                        reason=(
                            "absence failures require counter/control probes, "
                            "which are outside the V1 value-probe loop"
                        ),
                    )
                )
                state["decision_log"].append(
                    {
                        "kind": "INSUFFICIENT",
                        "round": 1,
                        "reason": "unsupported absence/control-flow predicate",
                    }
                )
            else:
                self._deterministic_static_closure(state, store)
                initial_bundle = self._probe_bundle(
                    state,
                    criterion.probe_budget,
                    "manifestation and active causal cut",
                )
                state["probe_bundle"] = asdict(initial_bundle)
                if initial_bundle.sites:
                    state["phase"] = "AWAITING_EVIDENCE"
                    manifestation_sites = [
                        site.site_id
                        for site in initial_bundle.sites
                        if site.node_id == state["manifestation_node_id"]
                    ]
                    if not manifestation_sites:
                        # A return/raise manifestation can be represented by
                        # the nearest executable checkpoint rather than the
                        # canonical sink node itself. Identify that proxy by
                        # the requested manifestation watch, never by bundle
                        # ordering (which is priority-sorted).
                        watch_path = criterion.watch_path
                        proxies = [
                            site
                            for site in initial_bundle.sites
                            if watch_path in site.watch_paths
                        ]
                        if proxies:
                            nearest = min(
                                int(
                                    state["node_distances"].get(
                                        site.node_id, 10_000
                                    )
                                )
                                for site in proxies
                            )
                            manifestation_sites = [
                                site.site_id
                                for site in proxies
                                if int(
                                    state["node_distances"].get(
                                        site.node_id, 10_000
                                    )
                                )
                                == nearest
                            ]
                    state["manifestation_site_ids"] = manifestation_sites
                else:
                    state["phase"] = "DECIDING"
                    self._refresh_region_actions(state)
            state["stats"]["fragmentsLoaded"] = len(
                state["expanded_functions"]
            )
            state["stats"]["startedMs"] = round(
                (time.perf_counter() - started) * 1000, 3
            )
            cache.save_investigation(investigation_id, state)
            return self._view(state)

    def get(
        self,
        investigation_id: str,
        *,
        since_revision: int | None = None,
        focus_traversal_id: str | None = None,
    ) -> dict[str, object]:
        with AnalysisCache(self.root, self.cache_path) as cache:
            return self._view(
                cache.load_investigation(investigation_id),
                since_revision=since_revision,
                focus_traversal_id=focus_traversal_id,
            )

    def record_evidence(
        self,
        investigation_id: str,
        observations: Iterable[ValueObservation],
    ) -> dict[str, object]:
        with AnalysisCache(self.root, self.cache_path) as cache:
            state = cache.load_investigation(investigation_id)
            incoming = list(observations)
            existing_observation_ids = {
                value["observation_id"] for value in state["observations"]
            }
            recorded: list[ValueObservation] = []
            for observation in incoming:
                if observation.site_id not in state["sites"]:
                    raise ValueError(
                        f"unknown investigation site {observation.site_id}"
                    )
                if not observation.occurrence_id.startswith("trace:"):
                    raise ValueError(
                        "only explicitly correlated trace occurrences are evidence"
                    )
                if observation.observation_id in existing_observation_ids:
                    continue
                encoded_observation = asdict(observation)
                encoded_observation["recorded_revision"] = (
                    int(state.get("revision", 1)) + 1
                )
                state["observations"].append(encoded_observation)
                existing_observation_ids.add(observation.observation_id)
                recorded.append(observation)
            occurrence_ids = {
                observation.occurrence_id for observation in recorded
            }
            if len(occurrence_ids) > 1:
                raise ValueError(
                    "submit exactly one correlated failing occurrence per replay"
                )
            if recorded:
                state["revision"] = int(state.get("revision", 1)) + 1
                state["last_occurrence_id"] = recorded[0].occurrence_id
                state["last_evidence_revision"] = state["revision"]
                self._build_dossiers_and_judgments(state, recorded)
                if state["phase"] == "CONFIRMING":
                    self._assess_candidate_confirmation(
                        state,
                        recorded[0].occurrence_id,
                    )
                elif state["status"] == "ACTIVE":
                    state["phase"] = "DECIDING"
                    self._refresh_region_actions(state)
            state["decision_log"].append(
                {
                    "kind": "EVIDENCE_RECORDED",
                    "round": state["round"],
                    "revision": state["revision"],
                    "occurrenceId": (
                        next(iter(occurrence_ids)) if occurrence_ids else None
                    ),
                    "observationIds": [
                        observation.observation_id
                        for observation in recorded
                    ],
                }
            )
            cache.save_investigation(investigation_id, state)
            return self._view(state)

    def decide(
        self,
        investigation_id: str,
        decision: InvestigationDecision,
    ) -> dict[str, object]:
        with AnalysisCache(self.root, self.cache_path) as cache:
            state = cache.load_investigation(investigation_id)
            current_revision = int(state.get("revision", 1))
            if (
                decision.based_on_revision is not None
                and decision.based_on_revision != current_revision
            ):
                raise ValueError(
                    "stale investigation decision: "
                    f"expected revision {current_revision}, "
                    f"received {decision.based_on_revision}"
                )
            if state["phase"] in {"AWAITING_EVIDENCE", "CONFIRMING"}:
                raise ValueError(
                    f"cannot decide while investigation is {state['phase']}"
                )
            store = LazyGraphStore(
                cache,
                state["criterion"]["commit"],
                tuple(state["criterion"].get("source_roots", ())),
            )
            active_action_ids = set(
                state.get("active_action_ids")
                or (
                    action_id
                    for action_id, branch in state["branches"].items()
                    if branch["status"] == "AVAILABLE"
                )
            )
            actions = {
                action_id: branch
                for action_id, branch in state["branches"].items()
                if branch["status"] == "AVAILABLE"
                and action_id in active_action_ids
            }
            unknown = set(decision.action_ids) - set(actions)
            if unknown:
                raise ValueError(
                    f"unknown or unavailable action IDs: {sorted(unknown)}"
                )
            if len(decision.action_ids) > 2:
                raise ValueError("choose at most two investigation actions")

            selected_kinds = {
                actions[action_id]["public"]["kind"]
                for action_id in decision.action_ids
            }
            if selected_kinds & {
                "FOLLOW_PATH",
                "PROBE_REGION",
                "CONFIRM_CANDIDATE",
            }:
                state["probe_focus_node_ids"] = []
                state["probe_focus_traversal_ids"] = []
            needs_replay = False
            static_changed = False
            expanded_traversal_ids: list[str] = []
            for action_id in decision.action_ids:
                branch = actions[action_id]
                branch["status"] = "SELECTED"
                kind = branch["public"]["kind"]
                if kind == "FOLLOW_PATH":
                    expanded_traversal_ids.append(
                        self._follow_branch(state, store, branch)
                    )
                    branch["status"] = "EXPANDED"
                    static_changed = True
                elif kind == "PROBE_REGION":
                    self._probe_region(state, branch)
                    branch["status"] = "APPLIED"
                    needs_replay = True
                elif kind == "INSPECT_MECHANISM":
                    self._inspect_mechanism(state, store, branch)
                    branch["status"] = "APPLIED"
                elif kind == "CONFIRM_CANDIDATE":
                    if decision.candidate_mechanism is None:
                        raise ValueError(
                            "CONFIRM_CANDIDATE requires a candidate mechanism"
                        )
                    self._begin_candidate_confirmation(
                        state,
                        decision.candidate_mechanism,
                        branch,
                    )
                    branch["status"] = "APPLIED"
                    needs_replay = True
                elif kind == "COMPLETE_LOCALIZATION":
                    self._complete_localization(
                        state, decision.evidence_refs
                    )
                    branch["status"] = "APPLIED"
                elif kind == "HANDOFF_BOUNDARY":
                    state["phase"] = "HANDOFF"
                    state["status"] = "HANDOFF"
                    branch["status"] = "APPLIED"

            if (
                decision.candidate_mechanism is not None
                and "CONFIRM_CANDIDATE" not in selected_kinds
            ):
                raise ValueError(
                    "candidate mechanisms are accepted only with CONFIRM_CANDIDATE"
                )
            state["revision"] = current_revision + 1
            if len(expanded_traversal_ids) > 1:
                state["active_focus_traversal_ids"] = list(
                    dict.fromkeys(expanded_traversal_ids)
                )
                state["active_focus_node_ids"] = list(
                    dict.fromkeys(
                        node_id
                        for traversal_id in expanded_traversal_ids
                        for node_id in state["traversals"][traversal_id].get(
                            "member_node_ids", ()
                        )
                    )
                )
                state["probe_focus_traversal_ids"] = list(
                    state["active_focus_traversal_ids"]
                )
                state["probe_focus_node_ids"] = list(
                    state["active_focus_node_ids"]
                )
                state["probe_focus_paths_by_node"] = {
                    node_id: list(
                        state["tracked_paths_by_node"].get(node_id, ())
                    )
                    for node_id in state["probe_focus_node_ids"]
                }
            if (
                static_changed
                and not needs_replay
                and state["status"] == "ACTIVE"
            ):
                self._deterministic_static_closure(state, store)
                state["phase"] = "DECIDING"
                state["probe_bundle"] = None
                self._refresh_region_actions(state)
            if needs_replay and state["status"] == "ACTIVE":
                state["round"] += 1
                next_bundle = self._probe_bundle(
                    state,
                    int(state["criterion"]["probe_budget"]),
                    (
                        "candidate confirmation"
                        if state["phase"] == "CONFIRMING"
                        else "question-driven frontier probe"
                    ),
                )
                state["probe_bundle"] = asdict(next_bundle)
                if state["phase"] != "CONFIRMING" and next_bundle.sites:
                    state["phase"] = "AWAITING_EVIDENCE"
                elif state["phase"] != "CONFIRMING":
                    state["phase"] = "DECIDING"
                    self._refresh_region_actions(state)
            elif not static_changed and state["status"] == "ACTIVE":
                self._refresh_active_frontier(state)
            state["stats"]["fragmentsLoaded"] = len(
                state["expanded_functions"]
            )
            state["decision_log"].append(
                {
                    "kind": "AI_SRE_DECISION",
                    "round": state["round"],
                    "revision": state["revision"],
                    "actionIds": list(decision.action_ids),
                    "explorationQuestion": decision.exploration_question,
                }
            )
            cache.save_investigation(investigation_id, state)
            return self._view(state)

    def result(self, investigation_id: str) -> dict[str, object]:
        with AnalysisCache(self.root, self.cache_path) as cache:
            state = cache.load_investigation(investigation_id)
            return {
                "investigationId": investigation_id,
                "status": state["status"],
                "phase": state["phase"],
                "candidateMechanism": state.get("candidate_mechanism"),
                "completionEvidence": state.get("completionEvidence", ()),
                "coverageNotes": state["coverage_notes"],
                "judgments": state["judgments"],
                "decisionLog": state["decision_log"],
                "stats": state["stats"],
            }

    def _ensure_traversal(
        self,
        state: dict[str, Any],
        *,
        function_id: str,
        service_id: str,
        anchors: tuple[str, ...],
        tracked: tuple[str, ...],
        depth: int,
        parent_traversal_id: str | None = None,
        via_node_id: str | None = None,
        boundary_kind: str | None = None,
        boundary_detail: str | None = None,
    ) -> tuple[str, bool]:
        """Create or merge a runtime context over canonical source."""

        normalized_anchors = tuple(sorted(set(anchors)))
        normalized_tracked = tuple(sorted(set(tracked)))
        traversal_id = _identifier(
            "trv",
            state["investigation_id"],
            function_id,
            service_id,
            normalized_anchors,
            normalized_tracked,
        )
        traversals = state.setdefault("traversals", {})
        existing = traversals.get(traversal_id)
        hop_model = (
            TraversalHop(
                parent_traversal_id=parent_traversal_id,
                via_node_id=via_node_id or "",
                boundary_kind=boundary_kind,
                boundary_detail=boundary_detail,
            )
            if parent_traversal_id is not None
            else None
        )
        hop = asdict(hop_model) if hop_model is not None else None
        if existing is not None:
            if parent_traversal_id is not None:
                parents = list(existing.get("parent_traversal_ids", ()))
                if parent_traversal_id not in parents:
                    parents.append(parent_traversal_id)
                    existing["parent_traversal_ids"] = parents
                hops = list(existing.get("incoming_hops", ()))
                hop_key = (
                    parent_traversal_id,
                    via_node_id or "",
                    boundary_kind,
                    boundary_detail,
                )
                if not any(
                    (
                        value.get("parent_traversal_id"),
                        value.get("via_node_id", ""),
                        value.get("boundary_kind"),
                        value.get("boundary_detail"),
                    )
                    == hop_key
                    for value in hops
                ):
                    hops.append(hop)
                    existing["incoming_hops"] = hops
            existing["depth"] = min(int(existing.get("depth", depth)), depth)
            return traversal_id, False

        traversal = RuntimeTraversal(
            traversal_id=traversal_id,
            function_id=function_id,
            service_id=service_id,
            anchor_node_ids=normalized_anchors,
            tracked_paths=normalized_tracked,
            parent_traversal_ids=(
                (parent_traversal_id,)
                if parent_traversal_id is not None
                else ()
            ),
            incoming_hops=(hop_model,) if hop_model is not None else (),
            depth=depth,
        )
        traversals[traversal_id] = asdict(traversal)
        active = state.setdefault("active_traversal_ids", [])
        if traversal_id not in active:
            active.append(traversal_id)
        return traversal_id, True

    def _record_traversal_edges(
        self,
        state: dict[str, Any],
        traversal_id: str,
        parent_traversal_id: str,
        via_node_id: str,
        edge_ids: Iterable[str],
    ) -> None:
        traversal = state["traversals"][traversal_id]
        values = tuple(sorted(set(edge_ids)))
        for hop in traversal.get("incoming_hops", ()):
            if (
                hop.get("parent_traversal_id") == parent_traversal_id
                and hop.get("via_node_id", "") == via_node_id
            ):
                hop["edge_ids"] = list(
                    dict.fromkeys((*hop.get("edge_ids", ()), *values))
                )

    def _expand(
        self,
        state: dict[str, Any],
        store: LazyGraphStore,
        function_id: str,
        anchors: tuple[str, ...],
        tracked: tuple[str, ...],
        *,
        via: str,
        base_distance: int,
        traversal_id: str,
    ) -> list[str]:
        traversal = state["traversals"][traversal_id]
        if traversal["function_id"] != function_id:
            raise ValueError("traversal function does not match expansion")
        if traversal.get("status") == "EXPANDED":
            return []
        fragment = store.fragment(function_id)
        state.setdefault("probe_focus_node_ids", [])
        state.setdefault("probe_focus_traversal_ids", [])
        existing_actions = set(state["branches"])
        nodes, edges, distances, tracked_by_node = _local_backward(
            fragment, anchors, tracked
        )
        calls_by_node: dict[str, set[str]] = defaultdict(set)
        for call in fragment.calls:
            calls_by_node[call.node_id].update(
                {
                    call.target,
                    call.target.rsplit(".", 1)[-1],
                    call.target.split(".", 1)[0],
                }
            )
        traversal["member_node_ids"] = sorted(
            set(traversal.get("member_node_ids", ())) | nodes
        )
        for node_id in nodes:
            node = next(
                value for value in fragment.nodes if value.node_id == node_id
            )
            raw = asdict(node)
            raw["source"] = node.source[:500]
            state["graph_nodes"][node_id] = raw
            distance = base_distance + distances.get(node_id, 0)
            state["node_distances"][node_id] = min(
                int(state["node_distances"].get(node_id, distance)),
                distance,
            )
            traversal_ids = state["node_traversal_ids"].setdefault(node_id, [])
            if traversal_id not in traversal_ids:
                traversal_ids.append(traversal_id)
            if node_id not in state["focus_node_ids"]:
                state["focus_node_ids"].append(node_id)
            if node_id not in state["probe_focus_node_ids"]:
                state["probe_focus_node_ids"].append(node_id)
            tracked_values = state["tracked_paths_by_node"].setdefault(
                node_id, []
            )
            tracked_values[:] = list(
                dict.fromkeys(
                    (
                        *tracked_values,
                        *sorted(tracked_by_node.get(node_id, ())),
                    )
                )
            )
            callable_values = state["callable_paths_by_node"].setdefault(
                node_id, []
            )
            callable_values[:] = list(
                dict.fromkeys(
                    (*callable_values, *sorted(calls_by_node.get(node_id, ())))
                )
            )
        if traversal_id not in state["focus_traversal_ids"]:
            state["focus_traversal_ids"].append(traversal_id)
        if traversal_id not in state["probe_focus_traversal_ids"]:
            state["probe_focus_traversal_ids"].append(traversal_id)
        state["active_focus_node_ids"] = sorted(nodes)
        state["active_focus_traversal_ids"] = [traversal_id]
        state["probe_focus_node_ids"] = sorted(nodes)
        state["probe_focus_traversal_ids"] = [traversal_id]
        state["probe_focus_paths_by_node"] = {
            node_id: list(state["tracked_paths_by_node"].get(node_id, ()))
            for node_id in nodes
        }
        existing_edges = {
            (
                value["source"],
                value["target"],
                value["kind"],
                value.get("variable"),
            )
            for value in state["graph_edges"]
        }
        for edge in edges:
            key = (edge.source, edge.target, edge.kind, edge.variable)
            if key not in existing_edges:
                state["graph_edges"].append(asdict(edge))
                existing_edges.add(key)
        state["causal_path_cache"] = {}
        if function_id not in state["expanded_functions"]:
            state["expanded_functions"].append(function_id)
            state["decision_log"].append(
                {
                    "kind": "STATIC_FUNCTION_EXPANDED",
                    "functionId": function_id,
                    "nodes": len(nodes),
                }
            )
        traversal["status"] = "EXPANDED"
        state["coverage_notes"].extend(
            note
            for note in fragment.coverage_notes
            if note not in state["coverage_notes"]
        )
        state["decision_log"].append(
            {
                "kind": "TRAVERSAL_EXPANDED",
                "traversalId": traversal_id,
                "functionId": function_id,
                "serviceId": traversal["service_id"],
                "via": via,
                "nodes": len(nodes),
            }
        )
        self._discover_branches(
            state,
            store,
            fragment,
            nodes,
            tracked,
            base_distance,
            traversal_id,
        )
        return [
            action_id
            for action_id in state["branches"]
            if action_id not in existing_actions
            and state["branches"][action_id]["status"] == "AVAILABLE"
            and state["branches"][action_id]["public"]["kind"] == "FOLLOW_PATH"
        ]

    def _discover_branches(
        self,
        state: dict[str, Any],
        store: LazyGraphStore,
        fragment: FunctionFragment,
        nodes: set[str],
        tracked: tuple[str, ...],
        base_distance: int,
        traversal_id: str,
    ) -> None:
        summary = store.by_id[fragment.function_id]
        runtime_service = str(
            state["traversals"][traversal_id]["service_id"]
        )
        for call in fragment.calls:
            if call.node_id not in nodes or not call.result_paths:
                continue
            node_tracked = tuple(
                state.get("tracked_paths_by_node", {}).get(
                    call.node_id, ()
                )
            )
            if node_tracked and not any(
                _path_matches(result_path, tracked_path)
                for result_path in call.result_paths
                for tracked_path in node_tracked
            ):
                continue
            if call.boundary_kind == "local":
                for callee in store.resolve_callees(summary, call):
                    self._add_follow_action(
                        state,
                        callee,
                        "local-call",
                        call.node_id,
                        (),
                        source_traversal_id=traversal_id,
                        boundary_kind=None,
                        boundary_detail=None,
                        target_service_id=runtime_service,
                        anchor_kind="return",
                        dependency_role=call.contribution_role,
                        estimated_nodes=max(
                            1, callee.end_line - callee.start_line
                        ),
                    )
            elif call.boundary_kind == "http":
                producers = store.resolve_http_producers(call)
                for producer in producers:
                    producer_outputs = {
                        dependency.output_path
                        for dependency in producer.dependencies
                    }
                    producer_tracked = tuple(
                        dict.fromkeys(
                            path.rsplit(".", 1)[-1]
                            for path in tracked
                            if path.rsplit(".", 1)[-1]
                            in producer_outputs
                        )
                    )
                    self._add_follow_action(
                        state,
                        producer,
                        "HTTP response producer",
                        call.node_id,
                        producer_tracked,
                        source_traversal_id=traversal_id,
                        boundary_kind="http",
                        boundary_detail=call.boundary_detail,
                        target_service_id=_runtime_service(
                            producer.file,
                            state["criterion"].get("ownership_map", ()),
                            _source_root(producer.file),
                        ),
                        anchor_kind="return",
                        dependency_role=call.contribution_role,
                        estimated_nodes=max(
                            1, producer.end_line - producer.start_line
                        ),
                    )
                if not producers:
                    state["coverage_notes"].append(
                        f"unresolved HTTP producer for {call.target}"
                    )

        for access in fragment.durable_accesses:
            if access.node_id not in nodes or access.operation != "read":
                continue
            writers = store.resolve_durable_writers(
                access.resource, access.fields
            )
            for writer, anchor, shared in writers:
                self._add_follow_action(
                    state,
                    writer,
                    f"durable writer for {access.resource}",
                    access.node_id,
                    shared,
                    source_traversal_id=traversal_id,
                    boundary_kind="durable",
                    boundary_detail=access.resource,
                    target_service_id=_runtime_service(
                        writer.file,
                        state["criterion"].get("ownership_map", ()),
                        _source_root(writer.file),
                    ),
                    anchor_kind="node",
                    dependency_role="HISTORICAL_STATE_PRODUCER",
                    target_anchor=anchor,
                    estimated_nodes=max(
                        1, writer.end_line - writer.start_line
                    ),
                )
            if not writers:
                self._add_boundary_handoff(
                    state,
                    access.node_id,
                    "durable",
                    f"origin is outside indexed code behind {access.resource}",
                )

        entry_included = fragment.entry_node in nodes
        if entry_included:
            callers = store.resolve_callers(summary)
            incoming_hops = state["traversals"][traversal_id].get(
                "incoming_hops", ()
            )
            if incoming_hops:
                known_local_callers: set[tuple[str, str]] = set()
                for hop in incoming_hops:
                    if hop.get("boundary_kind") is not None:
                        continue
                    parent = state["traversals"].get(
                        str(hop.get("parent_traversal_id", "")), {}
                    )
                    known_local_callers.add(
                        (
                            str(parent.get("function_id", "")),
                            str(hop.get("via_node_id", "")),
                        )
                    )
                callers = [
                    (caller, call)
                    for caller, call in callers
                    if (caller.function_id, call.node_id)
                    in known_local_callers
                ]
            for caller, call in callers:
                argument_paths = tuple(
                    sorted(
                        {
                            path
                            for paths in call.argument_paths
                            for path in paths
                        }
                    )
                )
                self._add_follow_action(
                    state,
                    caller,
                    "caller argument producer",
                    fragment.entry_node,
                    argument_paths,
                    source_traversal_id=traversal_id,
                    boundary_kind=None,
                    boundary_detail=None,
                    target_service_id=runtime_service,
                    anchor_kind="node",
                    dependency_role="VALUE_PRODUCER",
                    target_anchor=call.node_id,
                    estimated_nodes=max(
                        1, caller.end_line - caller.start_line
                    ),
                )

        if not any(
            branch["status"] == "AVAILABLE"
            and branch["public"]["kind"] == "FOLLOW_PATH"
            and branch["public"].get("dependency_role")
            in _BLOCKING_DEPENDENCY_ROLES
            and branch["meta"].get("sourceTraversalId") == traversal_id
            for branch in state["branches"].values()
        ):
            origin = max(
                nodes,
                key=lambda node_id: state["node_distances"].get(node_id, 0),
            )
            self._add_mechanism_action(
                state,
                origin,
                "static path terminates in this function",
                (traversal_id,),
            )

    def _add_follow_action(
        self,
        state: dict[str, Any],
        summary: FunctionSummary,
        reason: str,
        via_node: str,
        tracked: tuple[str, ...],
        *,
        source_traversal_id: str,
        boundary_kind: str | None,
        boundary_detail: str | None,
        target_service_id: str,
        anchor_kind: str,
        dependency_role: str,
        estimated_nodes: int,
        target_anchor: str | None = None,
    ) -> None:
        action_id = _identifier(
            "act",
            "FOLLOW_PATH",
            summary.function_id,
            target_anchor,
            tracked,
            via_node,
            source_traversal_id,
            target_service_id,
        )
        if action_id in state["branches"]:
            return
        state["collapsed_functions"][summary.function_id] = {
            "functionId": summary.function_id,
            "file": summary.file,
            "qualifiedName": summary.qualified_name,
            "startLine": summary.start_line,
            "endLine": summary.end_line,
            "dependencies": [
                asdict(value) for value in summary.dependencies
            ],
            "coverageNotes": list(summary.coverage_notes),
        }
        public = InvestigationAction(
            action_id=action_id,
            kind="FOLLOW_PATH",
            label=f"Follow {summary.qualified_name}",
            reason=reason,
            function_id=summary.function_id,
            anchor_node_id=via_node,
            tracked_paths=tracked,
            boundary_kind=boundary_kind,
            estimated_nodes=estimated_nodes,
            source_traversal_id=source_traversal_id,
            target_service_id=target_service_id,
            dependency_role=dependency_role,  # type: ignore[arg-type]
        )
        state["branches"][action_id] = {
            "public": asdict(public),
            "status": "AVAILABLE",
            "meta": {
                "targetFunctionId": summary.function_id,
                "targetAnchor": target_anchor,
                "anchorKind": anchor_kind,
                "viaNode": via_node,
                "trackedPaths": list(tracked),
                "boundaryKind": boundary_kind,
                "boundaryDetail": boundary_detail,
                "targetServiceId": target_service_id,
                "sourceTraversalId": source_traversal_id,
                "dependencyRole": dependency_role,
            },
        }

    def _add_mechanism_action(
        self,
        state: dict[str, Any],
        node_id: str,
        reason: str,
        traversal_ids: tuple[str, ...] = (),
        candidate_node_ids: tuple[str, ...] = (),
    ) -> None:
        # A divergent call result says the origin is at or behind that
        # boundary. When its producer is resolved, continue into the producer
        # before offering source adjudication at the consumer-side call site.
        contextual_ids = traversal_ids or tuple(
            state.get("node_traversal_ids", {}).get(node_id, ())
        )
        if any(
            branch["status"] == "AVAILABLE"
            and branch["public"]["kind"] == "FOLLOW_PATH"
            and branch["public"].get(
                "dependency_role", "VALUE_PRODUCER"
            )
            in _BLOCKING_DEPENDENCY_ROLES
            and branch["meta"].get("viaNode") == node_id
            and (
                not contextual_ids
                or branch["meta"].get("sourceTraversalId")
                in contextual_ids
            )
            for branch in state["branches"].values()
        ):
            return
        action_id = _identifier(
            "act", "INSPECT_MECHANISM", node_id, contextual_ids
        )
        if action_id in state["branches"]:
            existing = state["branches"][action_id]["meta"]
            existing["candidateNodeIds"] = list(
                dict.fromkeys(
                    (
                        *existing.get("candidateNodeIds", ()),
                        *candidate_node_ids,
                    )
                )
            )
            return
        node = state["graph_nodes"].get(node_id, {})
        public = InvestigationAction(
            action_id=action_id,
            kind="INSPECT_MECHANISM",
            label=f"Inspect mechanism at {node.get('file', '?')}:{node.get('line', '?')}",
            reason=reason,
            function_id=node.get("function_id"),
            anchor_node_id=node_id,
            source_traversal_id=(
                contextual_ids[0] if contextual_ids else None
            ),
        )
        state["branches"][action_id] = {
            "public": asdict(public),
            "status": "AVAILABLE",
            "meta": {
                "anchorNode": node_id,
                "traversalIds": list(contextual_ids),
                "candidateNodeIds": list(
                    dict.fromkeys((node_id, *candidate_node_ids))
                ),
            },
        }

    def _add_boundary_handoff(
        self,
        state: dict[str, Any],
        node_id: str,
        boundary_kind: str,
        reason: str,
    ) -> None:
        action_id = _identifier(
            "act", "HANDOFF_BOUNDARY", node_id, boundary_kind
        )
        if action_id in state["branches"]:
            return
        public = InvestigationAction(
            action_id=action_id,
            kind="HANDOFF_BOUNDARY",
            label=f"Hand off at {boundary_kind} boundary",
            reason=reason,
            anchor_node_id=node_id,
            boundary_kind=boundary_kind,
        )
        state["branches"][action_id] = {
            "public": asdict(public),
            "status": "AVAILABLE",
            "meta": {"anchorNode": node_id},
        }

    def _refresh_region_actions(self, state: dict[str, Any]) -> None:
        """Materialize only the evidence-centered causal cut.

        The complete graph and unresolved branches stay in state. The model
        sees a small active frontier that can be regenerated from that state.
        """

        projections = build_graph_projections(
            nodes=state["graph_nodes"].values(),
            edges=state["graph_edges"],
            collapsed_functions=state["collapsed_functions"].values(),
            branches=state["branches"].values(),
            traversals=state["traversals"].values(),
            manifestation_node_id=state.get("manifestation_node_id"),
            focus_node_ids=state.get(
                "active_focus_node_ids", state["focus_node_ids"]
            ),
            focus_traversal_ids=state.get(
                "active_focus_traversal_ids",
                state.get("focus_traversal_ids", ()),
            ),
        )
        active_nodes = set(
            state.get("active_focus_node_ids", state["focus_node_ids"])
        )
        active_traversals = set(
            state.get(
                "active_focus_traversal_ids",
                state.get("focus_traversal_ids", ()),
            )
        )
        latest_occurrence = state.get("last_occurrence_id")
        observed_nodes = {
            node_id
            for observation in state["observations"]
            for node_id in _observation_nodes(state, observation)
        }
        latest_observed_nodes = {
            node_id
            for observation in state["observations"]
            if observation["occurrence_id"] == latest_occurrence
            for node_id in _observation_nodes(state, observation)
        }
        latest_provenance_nodes = {
            node_id
            for observation in state["observations"]
            if observation["occurrence_id"] == latest_occurrence
            for node_id in _observation_nodes(
                state, observation, include_provenance=True
            )
        }
        candidates: list[
            tuple[int, int, int, str, dict[str, Any], list[str]]
        ] = []
        for region in projections["segment"]["regions"]:
            member_ids = [
                node_id
                for node_id in region.get("member_node_ids", ())
                if node_id in state["graph_nodes"]
            ]
            if (
                not member_ids
                or all(
                    state["graph_nodes"][node_id].get("synthetic")
                    or state["graph_nodes"][node_id].get("probe_line") is None
                    for node_id in member_ids
                )
            ):
                continue
            distance = min(
                int(state["node_distances"].get(node_id, 10_000))
                for node_id in member_ids
            )
            candidates.append(
                (
                    -len(latest_observed_nodes.intersection(member_ids)),
                    -len(active_nodes.intersection(member_ids)),
                    -distance,
                    region["region_id"],
                    region,
                    member_ids,
                )
            )
        for (
            _,
            _,
            _,
            region_id,
            region,
            member_ids,
        ) in sorted(candidates)[:_REGION_CANDIDATE_LIMIT]:
            exit_ids = [
                node_id
                for node_id in region.get("exit_node_ids", ())
                if node_id in member_ids
            ]
            anchor = (exit_ids or member_ids)[0]
            traversal_ids = tuple(
                dict.fromkeys(
                    traversal_id
                    for node_id in member_ids
                    for traversal_id in state["node_traversal_ids"].get(
                        node_id, ()
                    )
                    if traversal_id in state["traversals"]
                )
            )
            action_id = _identifier(
                "act",
                "PROBE_REGION",
                region_id,
                traversal_ids,
            )
            if (
                region_id not in state["probed_region_ids"]
                and action_id not in state["branches"]
            ):
                public = InvestigationAction(
                    action_id=action_id,
                    kind="PROBE_REGION",
                    label=f"Probe {region['label']}",
                    reason=(
                        "observe this region's inputs, outputs, and control "
                        "values before choosing the next frontier"
                    ),
                    function_id=state["graph_nodes"][anchor]["function_id"],
                    anchor_node_id=anchor,
                    tracked_paths=tuple(
                        _minimal_path_antichain(
                            (
                                *region.get("output_paths", ()),
                                *region.get("input_paths", ()),
                                *region.get("control_paths", ()),
                            )
                        )
                    )[:8],
                    estimated_nodes=len(member_ids),
                    source_traversal_id=(
                        traversal_ids[0] if traversal_ids else None
                    ),
                    target_service_id=(
                        state["traversals"][traversal_ids[0]]["service_id"]
                        if traversal_ids
                        else None
                    ),
                    region_id=region_id,
                )
                state["branches"][action_id] = {
                    "public": asdict(public),
                    "status": "AVAILABLE",
                    "meta": {
                        "regionId": region_id,
                        "memberNodeIds": member_ids,
                        "traversalIds": list(traversal_ids),
                    },
                }
        blocking_follows = [
            branch
            for branch in state["branches"].values()
            if branch["status"] == "AVAILABLE"
            and branch["public"]["kind"] == "FOLLOW_PATH"
            and branch["public"].get(
                "dependency_role", "VALUE_PRODUCER"
            )
            in _BLOCKING_DEPENDENCY_ROLES
            and (
                not active_traversals
                or branch["meta"].get("sourceTraversalId")
                in active_traversals
            )
            and branch["meta"].get("viaNode")
            in (
                latest_observed_nodes
                if branch["public"].get("dependency_role")
                == "HISTORICAL_STATE_PRODUCER"
                else latest_provenance_nodes
            )
        ]
        witnessed_active = (
            latest_observed_nodes.intersection(active_nodes)
            or observed_nodes.intersection(active_nodes)
        )
        if witnessed_active and not blocking_follows:
            related = set(witnessed_active)
            for edge in state["graph_edges"]:
                if edge["kind"] not in {
                    "DATA",
                    "CONTROL",
                    "CALL_RETURN",
                    "HTTP_BOUNDARY",
                    "DURABLE_BOUNDARY",
                }:
                    continue
                if edge["source"] in witnessed_active:
                    related.add(edge["target"])
                if edge["target"] in witnessed_active:
                    related.add(edge["source"])
            candidate_nodes = tuple(
                sorted(
                    related.intersection(active_nodes),
                    key=lambda node_id: (
                        0 if node_id in latest_observed_nodes else 1,
                        -int(state["node_distances"].get(node_id, 0)),
                        int(state["graph_nodes"][node_id]["line"]),
                        node_id,
                    ),
                )[:8]
            )
            anchor = max(
                witnessed_active,
                key=lambda node_id: (
                    int(state["node_distances"].get(node_id, 0)),
                    -int(state["graph_nodes"][node_id]["line"]),
                ),
            )
            traversal_ids = tuple(
                traversal_id
                for traversal_id in state["node_traversal_ids"].get(
                    anchor, ()
                )
                if traversal_id in active_traversals
            ) or tuple(active_traversals)
            self._add_mechanism_action(
                state,
                anchor,
                "bounded witnessed dependence cut has no unresolved value producer",
                traversal_ids,
                candidate_nodes,
            )
        self._refresh_active_frontier(state)

    def _refresh_active_frontier(self, state: dict[str, Any]) -> None:
        available = [
            (action_id, branch)
            for action_id, branch in state["branches"].items()
            if branch["status"] == "AVAILABLE"
        ]
        if not available:
            state["active_action_ids"] = []
            return
        complete = [
            pair
            for pair in available
            if pair[1]["public"]["kind"] == "COMPLETE_LOCALIZATION"
        ]
        if complete:
            state["active_action_ids"] = [complete[0][0]]
            return
        if state.get("phase") == "MECHANISM":
            state["active_action_ids"] = [
                action_id
                for action_id, branch in available
                if branch["public"]["kind"] == "CONFIRM_CANDIDATE"
            ][:_ACTIVE_ACTION_LIMIT]
            return

        active_nodes = set(state.get("active_focus_node_ids", ()))
        active_traversals = set(
            state.get("active_focus_traversal_ids", ())
        )
        latest_occurrence = state.get("last_occurrence_id")
        latest_observed_nodes = {
            node_id
            for observation in state.get("observations", ())
            if observation["occurrence_id"] == latest_occurrence
            for node_id in _observation_nodes(state, observation)
        }
        latest_provenance_nodes = {
            node_id
            for observation in state.get("observations", ())
            if observation["occurrence_id"] == latest_occurrence
            for node_id in _observation_nodes(
                state, observation, include_provenance=True
            )
        }

        def is_current(branch: dict[str, Any]) -> bool:
            public = branch["public"]
            return (
                public.get("anchor_node_id") in active_nodes
                or public.get("source_traversal_id") in active_traversals
                or bool(
                    active_nodes.intersection(
                        branch.get("meta", {}).get("memberNodeIds", ())
                    )
                )
            )

        blocking = [
            pair
            for pair in available
            if pair[1]["public"]["kind"] == "FOLLOW_PATH"
            and pair[1]["public"].get(
                "dependency_role", "VALUE_PRODUCER"
            )
            in _BLOCKING_DEPENDENCY_ROLES
            and is_current(pair[1])
            and pair[1]["meta"].get("viaNode")
            in (
                latest_observed_nodes
                if pair[1]["public"].get("dependency_role")
                == "HISTORICAL_STATE_PRODUCER"
                else latest_provenance_nodes
            )
        ]
        inspections = [
            pair
            for pair in available
            if pair[1]["public"]["kind"] == "INSPECT_MECHANISM"
            and is_current(pair[1])
        ]
        probes = [
            pair
            for pair in available
            if pair[1]["public"]["kind"] == "PROBE_REGION"
            and is_current(pair[1])
        ]
        control_follows = [
            pair
            for pair in available
            if pair[1]["public"]["kind"] == "FOLLOW_PATH"
            and pair[1]["public"].get("dependency_role")
            in {"CONTROL_GUARD", "ACTIVATION_SOURCE"}
            and is_current(pair[1])
        ]
        if blocking:
            eligible = [*blocking, *probes[:1]]
        elif inspections:
            # Revealing one bounded witnessed cut is a deterministic transition;
            # control contributors remain recoverable if adjudication needs them.
            eligible = [
                max(
                    inspections,
                    key=lambda pair: (
                        len(
                            pair[1]
                            .get("meta", {})
                            .get("candidateNodeIds", ())
                        ),
                        int(
                            state["node_distances"].get(
                                pair[1]["public"].get("anchor_node_id"),
                                -1,
                            )
                        ),
                    ),
                )
            ]
        elif probes:
            eligible = probes
        elif control_follows:
            eligible = control_follows
        else:
            eligible = [pair for pair in available if is_current(pair[1])]
            if not eligible:
                eligible = available

        def rank(pair: tuple[str, dict[str, Any]]) -> tuple[int, int, str]:
            action_id, branch = pair
            public = branch["public"]
            kind_rank = {
                "INSPECT_MECHANISM": 0,
                "FOLLOW_PATH": 1,
                "PROBE_REGION": 2,
                "HANDOFF_BOUNDARY": 3,
            }.get(public["kind"], 4)
            distance = int(
                state["node_distances"].get(
                    public.get("anchor_node_id"), -1
                )
            )
            return kind_rank, -distance, action_id

        state["active_action_ids"] = [
            action_id
            for action_id, _ in sorted(eligible, key=rank)[
                :_ACTIVE_ACTION_LIMIT
            ]
        ]

    def _probe_region(
        self, state: dict[str, Any], branch: dict[str, Any]
    ) -> None:
        member_ids = [
            node_id
            for node_id in branch["meta"].get("memberNodeIds", ())
            if node_id in state["graph_nodes"]
        ]
        if not member_ids:
            raise ValueError("probe region has no observable canonical nodes")
        state["probe_focus_node_ids"] = member_ids
        state["probe_focus_traversal_ids"] = list(
            branch["meta"].get("traversalIds", ())
        )
        state["active_focus_node_ids"] = list(member_ids)
        state["active_focus_traversal_ids"] = list(
            branch["meta"].get("traversalIds", ())
        )
        requested = tuple(branch["public"].get("tracked_paths", ()))
        state["probe_focus_paths_by_node"] = {
            node_id: list(
                _minimal_path_antichain(
                    path
                    for path in requested
                    if any(
                        _path_matches(path, local)
                        for local in (
                            *state["graph_nodes"][node_id].get("defs", ()),
                            *state["graph_nodes"][node_id].get("uses", ()),
                            *state["tracked_paths_by_node"].get(node_id, ()),
                        )
                    )
                )
                or state["tracked_paths_by_node"].get(node_id, ())
            )
            for node_id in member_ids
        }
        region_id = str(branch["meta"]["regionId"])
        if region_id not in state["probed_region_ids"]:
            state["probed_region_ids"].append(region_id)

    def _add_complete_action(
        self, state: dict[str, Any], evidence_refs: tuple[str, ...]
    ) -> None:
        action_id = _identifier(
            "act",
            "COMPLETE_LOCALIZATION",
            state["investigation_id"],
            state["round"],
        )
        if action_id in state["branches"]:
            return
        public = InvestigationAction(
            action_id=action_id,
            kind="COMPLETE_LOCALIZATION",
            label="Complete verified localization",
            reason="a correlated verification execution reached the mechanism",
        )
        state["branches"][action_id] = {
            "public": asdict(public),
            "status": "AVAILABLE",
            "meta": {"verificationEvidence": list(evidence_refs)},
        }

    def _follow_branch(
        self,
        state: dict[str, Any],
        store: LazyGraphStore,
        branch: dict[str, Any],
    ) -> str:
        meta = branch["meta"]
        target = meta["targetFunctionId"]
        fragment = store.fragment(target)
        if meta["anchorKind"] == "return":
            anchors = tuple(
                node.node_id for node in fragment.nodes if node.kind == "Return"
            ) or (fragment.exit_node,)
        else:
            anchor = meta.get("targetAnchor")
            anchors = (anchor,) if anchor else (fragment.exit_node,)
        tracked = tuple(meta.get("trackedPaths", ()))
        parent_traversal_id = str(meta["sourceTraversalId"])
        parent_traversal = state["traversals"][parent_traversal_id]
        base = (
            int(
                state["node_distances"].get(
                    str(meta.get("viaNode", "")), 0
                )
            )
            + 1
        )
        traversal_id, _ = self._ensure_traversal(
            state,
            function_id=target,
            service_id=str(meta.get("targetServiceId", "unknown")),
            anchors=anchors,
            tracked=tracked,
            depth=int(parent_traversal.get("depth", 0)) + 1,
            parent_traversal_id=parent_traversal_id,
            via_node_id=str(meta.get("viaNode", "")),
            boundary_kind=meta.get("boundaryKind"),
            boundary_detail=meta.get("boundaryDetail"),
        )
        meta["targetTraversalId"] = traversal_id
        self._expand(
            state,
            store,
            target,
            anchors,
            tracked,
            via=branch["public"]["reason"],
            base_distance=base,
            traversal_id=traversal_id,
        )
        edge_ids = self._connect_follow_branch(state, branch, anchors)
        self._record_traversal_edges(
            state,
            traversal_id,
            parent_traversal_id,
            str(meta.get("viaNode", "")),
            edge_ids,
        )
        via_node = meta.get("viaNode")
        if (
            via_node in state["graph_nodes"]
            and via_node not in state["probe_focus_node_ids"]
        ):
            state["probe_focus_node_ids"].append(via_node)
        if (
            parent_traversal_id
            not in state["probe_focus_traversal_ids"]
        ):
            state["probe_focus_traversal_ids"].append(parent_traversal_id)
        return traversal_id

    def _deterministic_static_closure(
        self, state: dict[str, Any], store: LazyGraphStore
    ) -> None:
        """Expand a unique value-producing source chain without a replay."""

        for _ in range(_AUTO_EXPANSION_LIMIT):
            active_traversals = set(
                state.get("active_focus_traversal_ids", ())
            )
            candidates_by_traversal: dict[
                str, list[dict[str, Any]]
            ] = defaultdict(list)
            for branch in state["branches"].values():
                if not (
                    branch["status"] == "AVAILABLE"
                    and branch["public"]["kind"] == "FOLLOW_PATH"
                    and branch["public"].get(
                        "dependency_role", "VALUE_PRODUCER"
                    )
                    in _BLOCKING_DEPENDENCY_ROLES
                    and (
                        not active_traversals
                        or branch["meta"].get("sourceTraversalId")
                        in active_traversals
                    )
                ):
                    continue
                candidates_by_traversal[
                    str(branch["meta"].get("sourceTraversalId", ""))
                ].append(branch)
            candidates = [
                branches[0]
                for branches in candidates_by_traversal.values()
                if len(branches) == 1
            ]
            if not candidates:
                break
            expanded_ids: list[str] = []
            for branch in candidates:
                branch["status"] = "AUTO_SELECTED"
                expanded_ids.append(self._follow_branch(state, store, branch))
                branch["status"] = "EXPANDED"
                state["decision_log"].append(
                    {
                        "kind": "DETERMINISTIC_STATIC_EXPANSION",
                        "actionId": branch["public"]["action_id"],
                        "dependencyRole": branch["public"].get(
                            "dependency_role"
                        ),
                        "replayRequired": False,
                    }
                )
            if len(expanded_ids) > 1:
                state["active_focus_traversal_ids"] = list(
                    dict.fromkeys(expanded_ids)
                )
                state["active_focus_node_ids"] = list(
                    dict.fromkeys(
                        node_id
                        for traversal_id in expanded_ids
                        for node_id in state["traversals"][traversal_id].get(
                            "member_node_ids", ()
                        )
                    )
                )
                state["probe_focus_traversal_ids"] = list(
                    state["active_focus_traversal_ids"]
                )
                state["probe_focus_node_ids"] = list(
                    state["active_focus_node_ids"]
                )
                state["probe_focus_paths_by_node"] = {
                    node_id: list(
                        state["tracked_paths_by_node"].get(node_id, ())
                    )
                    for node_id in state["probe_focus_node_ids"]
                }

    def _connect_follow_branch(
        self,
        state: dict[str, Any],
        branch: dict[str, Any],
        producer_nodes: tuple[str, ...],
    ) -> tuple[str, ...]:
        meta = branch["meta"]
        consumer = meta.get("viaNode")
        if consumer not in state["graph_nodes"]:
            return ()
        boundary = meta.get("boundaryKind")
        kind = (
            "HTTP_BOUNDARY"
            if boundary == "http"
            else "DURABLE_BOUNDARY"
            if boundary == "durable"
            else "CALL_RETURN"
        )
        paths = tuple(meta.get("trackedPaths", ())) or (None,)
        existing = {
            (
                edge["source"],
                edge["target"],
                edge["kind"],
                edge.get("variable"),
            ): edge.get("edge_id")
            for edge in state["graph_edges"]
        }
        connected: list[str] = []
        for producer in producer_nodes:
            if producer not in state["graph_nodes"]:
                continue
            for path in paths:
                key = (producer, consumer, kind, path)
                if key in existing:
                    if existing[key]:
                        connected.append(str(existing[key]))
                    continue
                edge_id = _identifier(
                    "edge", producer, consumer, kind, path
                )
                state["graph_edges"].append(
                    asdict(
                        FlowEdge(
                            source=producer,
                            target=consumer,
                            kind=kind,
                            variable=path,
                            certainty=(
                                "MAY" if kind == "DURABLE_BOUNDARY" else "MUST"
                            ),
                            detail=meta.get("boundaryDetail"),
                            edge_id=edge_id,
                        )
                    )
                )
                existing[key] = edge_id
                connected.append(edge_id)
        return tuple(dict.fromkeys(connected))

    def _probe_bundle(
        self,
        state: dict[str, Any],
        budget: int,
        reason: str,
        *,
        include_covered: bool = False,
    ) -> ProbeBundle:
        if state.get("phase") == "CONFIRMING":
            confirmation_sites = tuple(
                InvestigationProbeSite(**state["sites"][site_id])
                for site_id in state.get("confirmation_site_ids", ())
                if site_id in state["sites"]
            )
            if confirmation_sites:
                return ProbeBundle(
                    bundle_id=_identifier(
                        "bnd",
                        state["investigation_id"],
                        state["round"],
                        tuple(site.site_id for site in confirmation_sites),
                    ),
                    round=int(state["round"]),
                    sites=confirmation_sites,
                    reason=reason,
                )
        probe_focus = [
            node_id
            for node_id in state.get("probe_focus_node_ids", ())
            if node_id in state["graph_nodes"]
        ]
        probe_focus_set = set(probe_focus)
        manifestation = state.get("manifestation_node_id")
        candidate_ids = [
            *(
                [manifestation]
                if manifestation in state["graph_nodes"]
                else []
            ),
            *(
                probe_focus
                if probe_focus
                else [
                    node_id
                    for node_id in state["focus_node_ids"]
                    if node_id not in probe_focus_set
                ]
            ),
        ]
        nodes = [
            value
            for node_id in candidate_ids
            if (value := state["graph_nodes"].get(node_id))
            and not value["synthetic"]
            and value.get("probe_line") is not None
        ]
        edge_by_node: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for edge in state["graph_edges"]:
            edge_by_node[edge["source"]].append(edge)
            edge_by_node[edge["target"]].append(edge)

        def priority(node: dict[str, Any]) -> tuple[int, int, int, str]:
            distance = int(
                state["node_distances"].get(node["node_id"], 0)
            )
            return (
                0
                if str(node.get("kind", "")).startswith("Assign")
                else 1
                if node.get("kind") == "Return"
                else 2,
                distance,
                0 if "conditional" in str(node.get("kind", "")) else 1,
                node["node_id"],
            )

        sites: list[InvestigationProbeSite] = []
        site_index_by_location: dict[tuple[str, str, int], int] = {}
        focus_ids = set(probe_focus)
        active_ids = set(state.get("active_focus_node_ids", ()))
        active_min_distance = min(
            (
                int(state["node_distances"].get(node_id, 0))
                for node_id in active_ids
            ),
            default=0,
        )
        covered = set(state.get("evidence_coverage", ()))
        planned_paths: set[tuple[str, str]] = set()
        preferred_traversals = set(
            state.get("probe_focus_traversal_ids", ())
        )
        max_sites = max(
            1,
            min(
                budget,
                8 if include_covered else _EXPLORATION_SITE_LIMIT,
            ),
        )
        for node in sorted(
            nodes,
            key=lambda value: (
                0
                if value["node_id"] == manifestation
                else 1
                if value["node_id"] in active_ids
                else 2
                if value["node_id"] in focus_ids
                else 3,
                *priority(value),
            ),
        ):
            if (
                node["node_id"] in active_ids
                and int(
                    state["node_distances"].get(node["node_id"], 0)
                )
                > active_min_distance + 2
            ):
                continue
            desired = tuple(
                state.get("probe_focus_paths_by_node", {}).get(
                    node["node_id"],
                    state.get("tracked_paths_by_node", {}).get(
                        node["node_id"], ()
                    ),
                )
            )
            available = (
                *node.get("defs", ()),
                *node.get("uses", ()),
            )
            conditional = "conditional" in str(node.get("kind", ""))
            node_services = {
                str(state["traversals"][traversal_id]["service_id"])
                for traversal_id in state["node_traversal_ids"].get(
                    node["node_id"], ()
                )
                if traversal_id in state["traversals"]
            }
            downstream_targets = {
                edge["target"]
                for edge in state["graph_edges"]
                if edge["kind"] == "DATA"
                and edge["source"] == node["node_id"]
                and edge["target"] in state["graph_nodes"]
            }
            if (
                not conditional
                and node_services
                and downstream_targets
                and all(
                    any(
                        any(
                            service_id == planned_service
                            and _path_matches(definition, planned_path)
                            for planned_service, planned_path in planned_paths
                        )
                        for service_id in node_services
                        for definition in state["graph_nodes"][
                            target_id
                        ].get("defs", ())
                    )
                    for target_id in downstream_targets
                )
            ):
                continue
            raw_paths: tuple[str, ...]
            if (
                node["node_id"] == manifestation
                and state["criterion"].get("watch_path")
            ):
                raw_paths = (str(state["criterion"]["watch_path"]),)
            elif node.get("kind") == "Return":
                raw_paths = tuple(node.get("uses", ()))
            elif desired:
                primary_paths = tuple(
                    path
                    for path in desired
                    if any(
                        _path_matches(path, local)
                        for local in available
                    )
                )
                if not primary_paths:
                    primary_paths = tuple(
                        definition
                        for definition in node.get("defs", ())
                        if any(
                            _path_matches(definition, path)
                            for path in desired
                        )
                    )
                if (
                    primary_paths
                    and not conditional
                    and not any(
                        (
                            service_id,
                            node["file"],
                            int(node["probe_line"]),
                        )
                        in site_index_by_location
                        for service_id in node_services
                    )
                    and all(
                        all(
                            (service_id, path) in planned_paths
                            for service_id in (
                                state["traversals"][traversal_id][
                                    "service_id"
                                ]
                                for traversal_id in state[
                                    "node_traversal_ids"
                                ].get(node["node_id"], ())
                                if traversal_id in state["traversals"]
                            )
                        )
                        for path in primary_paths
                    )
                ):
                    continue
                raw_paths = (
                    *primary_paths,
                    *node.get("defs", ()),
                    *node.get("uses", ()),
                )
            else:
                raw_paths = tuple(node.get("defs", ()))
            callable_paths = set(
                state.get("callable_paths_by_node", {}).get(
                    node["node_id"], ()
                )
            )
            paths = tuple(
                path
                for path in _minimal_path_antichain(raw_paths)
                if path not in callable_paths
                and not (
                    "." not in path
                    and any(
                        callable_path.startswith(path + ".")
                        for callable_path in callable_paths
                    )
                )
            )
            paths = paths[:6]
            if not paths:
                continue
            path_node_ids: dict[str, str] = {}
            for path in paths:
                if any(
                    _path_matches(path, definition)
                    for definition in node.get("defs", ())
                ):
                    path_node_ids[path] = node["node_id"]
                    continue
                sources = {
                    edge["source"]
                    for edge in state["graph_edges"]
                    if edge["kind"] == "DATA"
                    and edge["target"] == node["node_id"]
                    and isinstance(edge.get("variable"), str)
                    and _path_matches(path, str(edge["variable"]))
                    and edge["source"] in state["graph_nodes"]
                }
                path_node_ids[path] = (
                    next(iter(sources))
                    if len(sources) == 1
                    else node["node_id"]
                )
            edges = edge_by_node.get(node["node_id"], ())
            certainty = (
                "UNKNOWN"
                if any(edge["certainty"] == "UNKNOWN" for edge in edges)
                else "MAY"
                if any(edge["certainty"] == "MAY" for edge in edges)
                else "MUST"
            )
            node_traversals = [
                traversal_id
                for traversal_id in state["node_traversal_ids"].get(
                    node["node_id"], ()
                )
                if traversal_id in state["traversals"]
            ]
            preferred = [
                traversal_id
                for traversal_id in node_traversals
                if traversal_id in preferred_traversals
            ]
            contextual = preferred or node_traversals
            by_service: dict[str, list[str]] = defaultdict(list)
            for traversal_id in contextual:
                service_id = str(
                    state["traversals"][traversal_id]["service_id"]
                )
                by_service[service_id].append(traversal_id)
            for service_id, traversal_ids in sorted(by_service.items()):
                location = (
                    service_id,
                    node["file"],
                    int(node["probe_line"]),
                )
                deploy_paths = tuple(
                    path
                    for path in paths
                    if include_covered
                    or (
                        f"{service_id}\0{node['file']}\0"
                        f"{int(node['probe_line'])}\0{path}"
                    )
                    not in covered
                )
                if not include_covered and not conditional:
                    deploy_paths = tuple(
                        path
                        for path in deploy_paths
                        if (service_id, path) not in planned_paths
                    )
                if not deploy_paths:
                    continue
                existing_index = site_index_by_location.get(location)
                if existing_index is not None:
                    existing = sites[existing_index]
                    path_nodes = dict(existing.path_node_ids)
                    path_nodes.update(
                        (path, path_node_ids[path]) for path in deploy_paths
                    )
                    merged = InvestigationProbeSite(
                        site_id=existing.site_id,
                        node_id=existing.node_id,
                        function_id=existing.function_id,
                        file=existing.file,
                        line=existing.line,
                        watch_paths=tuple(
                            dict.fromkeys(
                                (*existing.watch_paths, *deploy_paths)
                            )
                        ),
                        reason=existing.reason,
                        certainty=(
                            "UNKNOWN"
                            if "UNKNOWN"
                            in {existing.certainty, certainty}
                            else "MAY"
                            if "MAY" in {existing.certainty, certainty}
                            else "MUST"
                        ),
                        service_id=existing.service_id,
                        traversal_ids=tuple(
                            sorted(
                                set(
                                    (
                                        *existing.traversal_ids,
                                        *traversal_ids,
                                    )
                                )
                            )
                        ),
                        path_node_ids=tuple(sorted(path_nodes.items())),
                    )
                    sites[existing_index] = merged
                    state["sites"][merged.site_id] = asdict(merged)
                    planned_paths.update(
                        (service_id, path) for path in deploy_paths
                    )
                    continue
                site_id = _identifier(
                    "cand",
                    state["investigation_id"],
                    service_id,
                    node["file"],
                    node["probe_line"],
                )
                site = InvestigationProbeSite(
                    site_id=site_id,
                    node_id=node["node_id"],
                    function_id=node["function_id"],
                    file=node["file"],
                    line=int(node["probe_line"]),
                    watch_paths=deploy_paths,
                    reason=(
                        "runtime checkpoint on active causal path"
                        if certainty == "MUST"
                        else "runtime witness for conservative flow"
                    ),
                    certainty=certainty,
                    service_id=service_id,
                    traversal_ids=tuple(sorted(set(traversal_ids))),
                    path_node_ids=tuple(
                        (path, path_node_ids[path]) for path in deploy_paths
                    ),
                )
                sites.append(site)
                state["sites"][site_id] = asdict(site)
                site_index_by_location[location] = len(sites) - 1
                planned_paths.update(
                    (service_id, path) for path in deploy_paths
                )
                if len(sites) >= max_sites:
                    break
            if len(sites) >= max_sites:
                break
        return ProbeBundle(
            bundle_id=_identifier(
                "bnd",
                state["investigation_id"],
                state["round"],
                tuple(site.site_id for site in sites),
            ),
            round=int(state["round"]),
            sites=tuple(sites),
            reason=reason,
        )

    def _build_dossiers_and_judgments(
        self,
        state: dict[str, Any],
        observations: Iterable[ValueObservation],
    ) -> None:
        observation_models = list(observations)
        existing_dossiers = {
            tuple(value)
            for value in state.setdefault("dossier_keys", [])
        }
        coverage = set(state.setdefault("evidence_coverage", []))
        causal_cache = state.setdefault("causal_path_cache", {})
        encoded_observations = {
            observation.observation_id: next(
                value
                for value in reversed(state["observations"])
                if value["observation_id"] == observation.observation_id
            )
            for observation in observation_models
        }
        for observation_model in observation_models:
            observation = encoded_observations[
                observation_model.observation_id
            ]
            site = state["sites"][observation["site_id"]]
            path_node_ids = dict(site.get("path_node_ids", ()))
            for path, value in observation["values"].items():
                evidence_node_id = path_node_ids.get(path, site["node_id"])
                coverage.add(
                    f"{site['service_id']}\0{site['file']}\0"
                    f"{int(site['line'])}\0{path}"
                )
                if (
                    isinstance(value, dict)
                    and value.get("t") == "truncated"
                    and value.get("v") == "unsupported"
                ):
                    continue
                key = (
                    observation["occurrence_id"],
                    observation["site_id"],
                    path,
                    int(observation["hit_index"]),
                )
                if key in existing_dossiers:
                    continue
                dossier_id = _identifier(
                    "dos",
                    state["investigation_id"],
                    *key,
                )
                dossier = ValueDossier(
                    dossier_id=dossier_id,
                    site_id=observation["site_id"],
                    watch_path=path,
                    symptom=state["criterion"]["symptom"],
                    location=f"{site['file']}:{site['line']}",
                    function_id=site["function_id"],
                    service_id=site["service_id"],
                    traversal_ids=tuple(site["traversal_ids"]),
                    value=value,
                    evidence_ref=observation["observation_id"],
                    occurrence_id=observation["occurrence_id"],
                    hit_index=int(observation["hit_index"]),
                    causal_path=tuple(
                        causal_cache.setdefault(
                            evidence_node_id,
                            list(
                                self._causal_path(
                                    state, evidence_node_id
                                )
                            ),
                        )
                    ),
                    sequence_index=observation.get("sequence_index"),
                    sequence_scope=observation.get("service_instance"),
                    timestamp=observation.get("timestamp"),
                    static_certainty=site["certainty"],
                    capture_status=observation["capture_status"],
                    coverage_notes=tuple(state["coverage_notes"]),
                )
                judgment = self._automatic_judgment(
                    state, dossier, observation["observation_id"]
                )
                encoded = asdict(dossier)
                if judgment is not None:
                    encoded["interpretation"] = judgment.classification
                    state["judgments"].append(asdict(judgment))
                    if judgment.classification == "VIOLATES":
                        self._add_mechanism_action(
                            state,
                            evidence_node_id,
                            "runtime value violates the active condition",
                            tuple(site.get("traversal_ids", ())),
                        )
                state["dossiers"].append(encoded)
                existing_dossiers.add(key)
        state["dossier_keys"] = [list(value) for value in sorted(existing_dossiers)]
        state["evidence_coverage"] = sorted(coverage)

    def _automatic_judgment(
        self,
        state: dict[str, Any],
        dossier: ValueDossier,
        observation_id: str,
    ) -> ValueJudgment | None:
        criterion = state["criterion"]
        value = dossier.value
        tag = value.get("t") if isinstance(value, dict) else None
        expected_tags = {
            "numeric": {"num"},
            "string": {"str"},
            "boolean": {"bool"},
            "mapping": {"obj"},
            "sequence": {"arr"},
        }
        expected_type = criterion.get("expected_type")
        scalar_mismatch = (
            expected_type in {"numeric", "string", "boolean"}
            and tag in {"num", "str", "bool", "null"}
            and tag not in expected_tags[expected_type]
        )
        structural_mismatch = (
            expected_type in {"mapping", "sequence"}
            and tag is not None
            and tag not in expected_tags[expected_type]
        )
        if expected_type and (scalar_mismatch or structural_mismatch):
            return ValueJudgment(
                judgment_id=_identifier(
                    "jud", dossier.dossier_id, "MECHANICAL", "type"
                ),
                dossier_id=dossier.dossier_id,
                classification="VIOLATES",
                basis="MECHANICAL",
                defeasible=False,
                evidence_refs=(observation_id,),
                rationale=f"expected {expected_type}, captured {tag or 'unknown'}",
            )
        numeric = (
            value.get("v")
            if isinstance(value, dict) and value.get("t") == "num"
            else None
        )
        if isinstance(numeric, (int, float)) and not isinstance(numeric, bool):
            minimum = criterion.get("minimum")
            maximum = criterion.get("maximum")
            below = minimum is not None and (
                numeric <= minimum
                if criterion.get("minimum_exclusive")
                else numeric < minimum
            )
            above = maximum is not None and (
                numeric >= maximum
                if criterion.get("maximum_exclusive")
                else numeric > maximum
            )
            if below or above:
                return ValueJudgment(
                    judgment_id=_identifier(
                        "jud", dossier.dossier_id, "MECHANICAL", "range"
                    ),
                    dossier_id=dossier.dossier_id,
                    classification="VIOLATES",
                    basis="MECHANICAL",
                    defeasible=False,
                    evidence_refs=(observation_id,),
                    rationale="captured number violates the manifestation range",
                )
        return None

    def _causal_path(
        self, state: dict[str, Any], node_id: str
    ) -> tuple[str, ...]:
        sink = state["manifestation_node_id"]
        outgoing: dict[str, list[str]] = defaultdict(list)
        for edge in state["graph_edges"]:
            outgoing[edge["source"]].append(edge["target"])
        queue = deque([(node_id, (node_id,))])
        seen = {node_id}
        while queue:
            current, path = queue.popleft()
            if current == sink:
                return tuple(
                    f"{state['graph_nodes'][value]['file']}:{state['graph_nodes'][value]['line']}"
                    for value in path
                    if value in state["graph_nodes"]
                )
            for target in outgoing.get(current, ()):
                if target in seen:
                    continue
                seen.add(target)
                queue.append((target, (*path, target)))
        return ()

    def _inspect_mechanism(
        self,
        state: dict[str, Any],
        store: LazyGraphStore,
        branch: dict[str, Any],
    ) -> None:
        node_id = branch["meta"]["anchorNode"]
        traversal_ids = set(branch["meta"].get("traversalIds", ()))
        node = state["graph_nodes"][node_id]
        store.fragment(node["function_id"])
        provided_candidates = [
            candidate_id
            for candidate_id in branch["meta"].get(
                "candidateNodeIds", ()
            )
            if candidate_id in state["graph_nodes"]
        ]
        related = set(provided_candidates) or {node_id}
        if not provided_candidates:
            for edge in state["graph_edges"]:
                if edge["source"] == node_id:
                    related.add(edge["target"])
                if edge["target"] == node_id:
                    related.add(edge["source"])
        if provided_candidates:
            # candidateNodeIds is already ranked with directly witnessed
            # producers first. Preserve that ordering so a bounded source
            # reveal cannot evict the exact statements that produced the
            # captured values in favor of more distant provenance.
            selected_ids = list(
                dict.fromkeys((node_id, *provided_candidates))
            )[:6]
        else:
            selected_ids = sorted(
                (
                    candidate_id
                    for candidate_id in related
                    if candidate_id in state["graph_nodes"]
                ),
                key=lambda candidate_id: (
                    0 if candidate_id == node_id else 1,
                    -int(
                        state["node_distances"].get(candidate_id, 0)
                    ),
                    int(state["graph_nodes"][candidate_id]["line"]),
                    candidate_id,
                ),
            )[:6]
        previous_nodes = list(state["probe_focus_node_ids"])
        previous_traversals = list(state["probe_focus_traversal_ids"])
        state["probe_focus_node_ids"] = selected_ids
        state["probe_focus_traversal_ids"] = sorted(traversal_ids)
        candidate_bundle = self._probe_bundle(
            state,
            min(8, int(state["criterion"]["probe_budget"])),
            "candidate mechanism probes",
            include_covered=True,
        )
        state["probe_focus_node_ids"] = previous_nodes
        state["probe_focus_traversal_ids"] = previous_traversals
        state["phase"] = "MECHANISM"
        state["mechanism_context"] = {
            "anchorNodeId": node_id,
            "traversalIds": sorted(traversal_ids),
            "statements": [
                {
                    key: state["graph_nodes"][candidate_id][key]
                    for key in (
                        "node_id",
                        "file",
                        "line",
                        "kind",
                        "source",
                        "defs",
                        "uses",
                    )
                }
                for candidate_id in selected_ids
            ],
            "probeCandidates": [
                asdict(site) for site in candidate_bundle.sites
            ],
            "evidenceRefs": [
                value["observation_id"]
                for value in state["observations"]
                if value["site_id"]
                in {site.site_id for site in candidate_bundle.sites}
            ],
        }
        action_id = _identifier(
            "act", "CONFIRM_CANDIDATE", state["investigation_id"], node_id
        )
        public = InvestigationAction(
            action_id=action_id,
            kind="CONFIRM_CANDIDATE",
            label="Confirm a candidate mechanism",
            reason=(
                "submit one concrete mechanism and predicted observations "
                "before the fresh confirmation replay"
            ),
            function_id=node["function_id"],
            anchor_node_id=node_id,
            source_traversal_id=(
                next(iter(sorted(traversal_ids)))
                if traversal_ids
                else None
            ),
        )
        state["branches"][action_id] = {
            "public": asdict(public),
            "status": "AVAILABLE",
            "meta": {
                "anchorNode": node_id,
                "traversalIds": sorted(traversal_ids),
            },
        }

    def _begin_candidate_confirmation(
        self,
        state: dict[str, Any],
        candidate: CandidateMechanism,
        branch: dict[str, Any],
    ) -> None:
        context = state.get("mechanism_context")
        if not isinstance(context, dict):
            raise ValueError("candidate confirmation requires mechanism context")
        allowed_anchors = {
            str(value["node_id"]) for value in context.get("statements", ())
        }
        anchors = set(candidate.anchor_node_ids)
        if not anchors or not anchors <= allowed_anchors:
            raise ValueError(
                "candidate anchors must come from the revealed mechanism statements"
            )
        allowed_traversals = set(context.get("traversalIds", ()))
        if candidate.traversal_id not in allowed_traversals:
            raise ValueError(
                "candidate traversal must come from the mechanism context"
            )
        allowed_sites = {
            str(site["site_id"]): site
            for site in context.get("probeCandidates", ())
        }
        if not candidate.predictions:
            raise ValueError(
                "candidate mechanism requires at least one predicted observation"
            )
        prediction_nodes: list[str] = []
        for prediction in candidate.predictions:
            site = allowed_sites.get(prediction.probe_candidate_id)
            if site is None:
                raise ValueError(
                    f"unknown candidate probe {prediction.probe_candidate_id}"
                )
            if prediction.watch_path not in site.get("watch_paths", ()):
                raise ValueError(
                    f"watch path {prediction.watch_path} is not available "
                    f"at {prediction.probe_candidate_id}"
                )
            if (
                prediction.operator in {"eq", "ne"}
                and prediction.expected_value is None
            ):
                raise ValueError(
                    f"{prediction.operator} prediction requires expected_value"
                )
            prediction_nodes.append(str(site["node_id"]))
        required_nodes = set(prediction_nodes) | {
            state["manifestation_node_id"]
        }
        if len(required_nodes) > int(state["criterion"]["probe_budget"]):
            raise ValueError(
                "candidate predictions exceed the confirmation probe budget"
            )
        encoded = asdict(candidate)
        encoded["status"] = "CONFIRMING"
        encoded["proposed_revision"] = int(state["revision"]) + 1
        state["candidate_mechanism"] = encoded
        state["confirmation_started_revision"] = int(state["revision"]) + 1
        state["phase"] = "CONFIRMING"
        manifestation_site_ids = list(
            state.get("manifestation_site_ids", ())
        )
        state["confirmation_site_ids"] = list(
            dict.fromkeys(
                (
                    *manifestation_site_ids,
                    *(
                        prediction.probe_candidate_id
                        for prediction in candidate.predictions
                    ),
                )
            )
        )
        confirmation_paths: dict[str, list[str]] = defaultdict(list)
        for site_id in manifestation_site_ids:
            site = state["sites"].get(site_id)
            if site is not None:
                manifestation_watch = state["criterion"].get("watch_path")
                if manifestation_watch in site["watch_paths"]:
                    confirmation_paths[site_id].append(manifestation_watch)
                else:
                    confirmation_paths[site_id].extend(site["watch_paths"][:1])
        for prediction in candidate.predictions:
            confirmation_paths[prediction.probe_candidate_id].append(
                prediction.watch_path
            )
        for site_id, watch_paths in confirmation_paths.items():
            if site_id in state["sites"]:
                # Confirmation probes capture only the values named by the
                # candidate (plus the manifestation). Reusing the broader
                # exploration watches can truncate an otherwise complete
                # scalar prediction and make confirmation nondeterministic.
                state["sites"][site_id]["watch_paths"] = list(
                    dict.fromkeys(watch_paths)
                )
        state["probe_focus_node_ids"] = list(
            dict.fromkeys(
                (
                    state["manifestation_node_id"],
                    *prediction_nodes,
                )
            )
        )
        state["probe_focus_traversal_ids"] = [candidate.traversal_id]

    def _assess_candidate_confirmation(
        self, state: dict[str, Any], occurrence_id: str
    ) -> None:
        candidate = state.get("candidate_mechanism")
        if not isinstance(candidate, dict):
            raise ValueError("confirmation has no candidate mechanism")
        occurrence = [
            observation
            for observation in state["observations"]
            if observation["occurrence_id"] == occurrence_id
        ]
        values_by_site: dict[str, dict[str, object]] = {}
        complete_sites: set[str] = set()
        for observation in occurrence:
            values_by_site.setdefault(observation["site_id"], {}).update(
                observation["values"]
            )
            if observation.get("capture_status") == "complete":
                complete_sites.add(observation["site_id"])
        results: list[dict[str, object]] = []
        contradicted = False
        incomplete = False
        for prediction in candidate.get("predictions", ()):
            values = values_by_site.get(
                str(prediction["probe_candidate_id"])
            )
            if (
                values is None
                or prediction["watch_path"] not in values
                or prediction["probe_candidate_id"] not in complete_sites
            ):
                matched = None
                incomplete = True
            else:
                matched = self._prediction_matches(
                    values[prediction["watch_path"]],
                    str(prediction["operator"]),
                    prediction.get("expected_value"),
                )
                contradicted = contradicted or not matched
            results.append({**prediction, "matched": matched})
        manifestation_seen = any(
            observation["site_id"]
            in set(state.get("manifestation_site_ids", ()))
            and observation.get("capture_status") == "complete"
            for observation in occurrence
        )
        incomplete = incomplete or not manifestation_seen
        candidate["confirmation"] = {
            "occurrence_id": occurrence_id,
            "predictions": results,
            "manifestation_seen": manifestation_seen,
        }
        state["confirmation_occurrence_id"] = occurrence_id
        if contradicted:
            candidate["status"] = "REJECTED"
            state["phase"] = "DECIDING"
            self._refresh_region_actions(state)
            return
        if incomplete:
            candidate["status"] = "INCONCLUSIVE"
            state["phase"] = "DECIDING"
            self._refresh_region_actions(state)
            return
        candidate["status"] = "SUPPORTED"
        state["phase"] = "DECIDING"
        self._add_complete_action(
            state,
            tuple(
                observation["observation_id"] for observation in occurrence
            ),
        )
        self._refresh_active_frontier(state)

    @staticmethod
    def _prediction_matches(
        captured: object, operator: str, expected: object
    ) -> bool:
        value = (
            captured.get("v")
            if isinstance(captured, dict)
            and captured.get("t") in {"num", "str", "bool", "null"}
            else captured
        )
        if operator == "present":
            return captured is not None
        if operator == "truthy":
            return bool(value)
        if operator == "falsy":
            return not bool(value)
        if operator == "eq":
            return value == expected
        if operator == "ne":
            return value != expected
        return False

    def _complete_localization(
        self, state: dict[str, Any], evidence_refs: tuple[str, ...]
    ) -> None:
        candidate = state.get("candidate_mechanism")
        if (
            state["phase"] != "DECIDING"
            or not isinstance(candidate, dict)
            or candidate.get("status") != "SUPPORTED"
        ):
            raise ValueError(
                "localization can complete only after supported confirmation"
            )
        known = {
            value["observation_id"] for value in state["observations"]
        }
        if not evidence_refs or not set(evidence_refs) <= known:
            raise ValueError(
                "completion requires valid verification evidence references"
            )
        confirmation = candidate.get("confirmation", {})
        required_occurrence = confirmation.get("occurrence_id")
        referenced_occurrences = {
            value["occurrence_id"]
            for value in state["observations"]
            if value["observation_id"] in evidence_refs
        }
        if referenced_occurrences != {required_occurrence}:
            raise ValueError(
                "completion evidence must come from the confirmation occurrence"
            )
        candidate["status"] = "CONFIRMED"
        state["phase"] = "LOCALIZED"
        state["status"] = "LOCALIZED"
        state["completionEvidence"] = list(evidence_refs)

    def _node_at(self, fragment: FunctionFragment, line: int) -> FlowNode:
        candidates = [
            node
            for node in fragment.nodes
            if not node.synthetic and node.line <= line <= node.end_line
        ]
        if not candidates:
            raise ValueError(
                f"no analyzed Python statement at {fragment.file}:{line}"
            )
        return min(
            candidates,
            key=lambda node: (
                node.end_line - node.line,
                abs(node.line - line),
            ),
        )

    @classmethod
    def _compact_evidence_value(
        cls, value: object, *, depth: int = 0
    ) -> object:
        if depth >= 3:
            return {"summary": type(value).__name__, "truncated": True}
        if isinstance(value, dict):
            tag = value.get("t")
            if tag == "truncated" and value.get("v") == "unsupported":
                return {"t": "unsupported"}
            items = list(value.items())
            compact = {
                str(key): cls._compact_evidence_value(
                    child, depth=depth + 1
                )
                for key, child in items[:8]
            }
            if len(items) > 8:
                compact["omittedKeys"] = len(items) - 8
            if len(json.dumps(compact, separators=(",", ":"))) > 768:
                return {
                    "t": tag or "mapping",
                    "keys": [str(key) for key, _ in items[:12]],
                    "size": len(items),
                    "truncated": True,
                }
            return compact
        if isinstance(value, (list, tuple)):
            compact_items = [
                cls._compact_evidence_value(child, depth=depth + 1)
                for child in value[:8]
            ]
            if len(value) > 8:
                compact_items.append({"omittedItems": len(value) - 8})
            return compact_items
        if isinstance(value, str) and len(value) > 500:
            return {
                "text": value[:500],
                "length": len(value),
                "truncated": True,
            }
        return value

    def _decision_context(
        self,
        state: dict[str, Any],
        projections: dict[str, dict[str, Any]],
        runtime_traversals: list[dict[str, Any]],
        available_actions: list[dict[str, Any]],
        dossiers: list[dict[str, Any]],
        *,
        since_revision: int | None,
    ) -> tuple[dict[str, Any], dict[str, dict[str, str]]]:
        observation_revisions = {
            observation["observation_id"]: int(
                observation.get("recorded_revision", 1)
            )
            for observation in state["observations"]
        }
        raw_mechanism = (
            state.get("mechanism_context")
            if state["phase"] == "MECHANISM"
            else None
        )
        mechanism_refs = (
            set(raw_mechanism.get("evidenceRefs", ()))
            if isinstance(raw_mechanism, dict)
            else set()
        )
        latest_occurrence = state.get("last_occurrence_id")
        selected_dossiers = [
            dossier
            for dossier in dossiers
            if (
                (
                    since_revision is not None
                    and observation_revisions.get(
                        dossier["evidence_ref"], 1
                    )
                    > since_revision
                )
                or (
                    since_revision is None
                    and (
                        dossier["occurrence_id"] == latest_occurrence
                        or dossier["evidence_ref"] in mechanism_refs
                    )
                )
            )
        ]
        deduplicated_evidence: dict[
            tuple[str, str, str], dict[str, Any]
        ] = {}
        for dossier in selected_dossiers:
            key = (
                str(dossier["service_id"]),
                str(dossier["location"]),
                str(dossier["watch_path"]),
            )
            deduplicated_evidence[key] = {
                "at": dossier["location"],
                "svc": dossier["service_id"],
                "path": dossier["watch_path"],
                "value": dossier["value"],
                "state": dossier["interpretation"],
                "certainty": dossier["static_certainty"],
            }
        evidence = list(deduplicated_evidence.values())[-10:]

        segment = projections["segment"]
        active_nodes = set(state.get("active_focus_node_ids", ()))
        evidence_nodes = {
            node_id
            for observation in state.get("observations", ())
            if observation["occurrence_id"] == latest_occurrence
            for node_id in _observation_nodes(state, observation)
        }
        regions = sorted(
            segment["regions"],
            key=lambda region: (
                -len(
                    evidence_nodes.intersection(
                        region.get("member_node_ids", ())
                    )
                ),
                -len(
                    active_nodes.intersection(
                        region.get("member_node_ids", ())
                    )
                ),
                min(
                    (
                        int(state["node_distances"].get(node_id, 10_000))
                        for node_id in region.get("member_node_ids", ())
                    ),
                    default=10_000,
                ),
                region["region_id"],
            ),
        )[:6]
        aliases = {
            region["region_id"]: f"r{index + 1}"
            for index, region in enumerate(regions)
        }
        region_rows = [
            {
                "id": aliases[region["region_id"]],
                "kind": region["kind"],
                "label": str(region["label"])[:160],
                "in": region.get("input_paths", ())[:4],
                "out": region.get("output_paths", ())[:4],
                "control": region.get("control_paths", ())[:3],
            }
            for region in regions
        ]
        edge_rows = [
            {
                "from": aliases[edge["source_region_id"]],
                "to": aliases[edge["target_region_id"]],
                "kind": edge["edge_kinds"],
                "path": edge["variable_paths"][:4],
            }
            for edge in segment["edges"]
            if edge["source_region_id"] in aliases
            and edge["target_region_id"] in aliases
        ][:8]

        action_aliases = {
            f"a{index + 1}": str(action["action_id"])
            for index, action in enumerate(available_actions)
        }
        action_alias_by_id = {
            action_id: alias
            for alias, action_id in action_aliases.items()
        }
        actions = [
            {
                "id": action_alias_by_id[str(action["action_id"])],
                "kind": action["kind"],
                "label": str(action["label"])[:180],
                **(
                    {"role": action["dependency_role"]}
                    if action.get("dependency_role")
                    else {}
                ),
                **(
                    {"service": action["target_service_id"]}
                    if action.get("target_service_id")
                    else {}
                ),
                **(
                    {"paths": action["tracked_paths"][:4]}
                    if action.get("tracked_paths")
                    else {}
                ),
            }
            for action in available_actions
        ]

        traversal_aliases: dict[str, str] = {}
        for traversal in runtime_traversals[-4:]:
            traversal_id = str(traversal["traversal_id"])
            traversal_aliases[f"t{len(traversal_aliases) + 1}"] = traversal_id
        if isinstance(raw_mechanism, dict):
            for traversal_id in raw_mechanism.get("traversalIds", ())[:4]:
                if traversal_id not in traversal_aliases.values():
                    traversal_aliases[
                        f"t{len(traversal_aliases) + 1}"
                    ] = str(traversal_id)
        traversal_alias_by_id = {
            traversal_id: alias
            for alias, traversal_id in traversal_aliases.items()
        }
        traversal_rows = []
        for traversal in runtime_traversals[-4:]:
            function_id = str(traversal["function_id"])
            summary = state["collapsed_functions"].get(function_id, {})
            traversal_rows.append(
                {
                    "id": traversal_alias_by_id[
                        str(traversal["traversal_id"])
                    ],
                    "function": summary.get(
                        "qualifiedName", function_id.rsplit(":", 2)[-2]
                    ),
                    "service": traversal["service_id"],
                    "depth": traversal.get("depth", 0),
                    "paths": traversal.get("tracked_paths", ())[:4],
                }
            )

        statement_aliases: dict[str, str] = {}
        probe_aliases: dict[str, str] = {}
        mechanism_context = None
        if isinstance(raw_mechanism, dict):
            statement_aliases = {
                f"s{index + 1}": str(statement["node_id"])
                for index, statement in enumerate(
                    raw_mechanism.get("statements", ())[:8]
                )
            }
            statement_alias_by_id = {
                node_id: alias
                for alias, node_id in statement_aliases.items()
            }
            probe_aliases = {
                f"p{index + 1}": str(site["site_id"])
                for index, site in enumerate(
                    raw_mechanism.get("probeCandidates", ())[:8]
                )
            }
            probe_alias_by_id = {
                site_id: alias
                for alias, site_id in probe_aliases.items()
            }
            mechanism_context = {
                "statements": [
                    {
                        "id": statement_alias_by_id[
                            str(statement["node_id"])
                        ],
                        "at": (
                            f"{statement.get('file')}:{statement.get('line')}"
                        ),
                        "kind": statement.get("kind"),
                        "source": str(statement.get("source", ""))[:700],
                        "defines": statement.get("defs", ())[:4],
                        "uses": statement.get("uses", ())[:4],
                    }
                    for statement in raw_mechanism.get("statements", ())[:8]
                ],
                "traversals": [
                    traversal_alias_by_id[str(traversal_id)]
                    for traversal_id in raw_mechanism.get(
                        "traversalIds", ()
                    )[:4]
                    if str(traversal_id) in traversal_alias_by_id
                ],
                "probes": [
                    {
                        "id": probe_alias_by_id[str(site["site_id"])],
                        "at": f"{site.get('file')}:{site.get('line')}",
                        "paths": site.get("watch_paths", ())[:4],
                    }
                    for site in raw_mechanism.get("probeCandidates", ())[:8]
                ],
            }

        active_ids = set(state.get("active_action_ids", ()))
        deferred_by_kind: dict[str, int] = defaultdict(int)
        for action_id, branch in state["branches"].items():
            if branch["status"] == "AVAILABLE" and action_id not in active_ids:
                deferred_by_kind[str(branch["public"]["kind"])] += 1
        context: dict[str, Any] = {
            "protocol": "liveprobe-adaptive-v2",
            "rev": int(state["revision"]),
            "incident": {
                "symptom": state["criterion"]["symptom"],
                "class": state["criterion"]["failure_class"],
            },
            "phase": state["phase"],
            "focus": {
                "regions": region_rows,
                "edges": edge_rows,
            },
            "traversals": traversal_rows,
            "evidence": evidence,
            "actions": actions,
            "deferred": {
                "count": sum(deferred_by_kind.values()),
                "byKind": dict(sorted(deferred_by_kind.items())),
            },
            **(
                {"mechanism": mechanism_context}
                if mechanism_context is not None
                else {}
            ),
        }
        limit = (
            _MECHANISM_PACKET_LIMIT_BYTES
            if mechanism_context is not None
            else _EXPLORATION_PACKET_LIMIT_BYTES
        )
        if len(json.dumps(context, separators=(",", ":")).encode()) > limit:
            context["evidence"] = evidence[-6:]
            context["focus"]["regions"] = region_rows[:4]
            retained = {
                region["id"] for region in context["focus"]["regions"]
            }
            context["focus"]["edges"] = [
                edge
                for edge in edge_rows
                if edge["from"] in retained and edge["to"] in retained
            ][:4]
            mechanism = context.get("mechanism")
            if isinstance(mechanism, dict):
                mechanism["statements"] = [
                    {
                        **statement,
                        "source": str(statement.get("source", ""))[:400],
                    }
                    for statement in mechanism.get("statements", ())[:6]
                ]
                mechanism["probes"] = mechanism.get("probes", ())[:6]
            context["truncated"] = True
        if len(json.dumps(context, separators=(",", ":")).encode()) > limit:
            context["focus"]["edges"] = []
            context["evidence"] = context["evidence"][-4:]
            mechanism = context.get("mechanism")
            if isinstance(mechanism, dict):
                mechanism["statements"] = mechanism.get("statements", ())[:4]
        if len(json.dumps(context, separators=(",", ":")).encode()) > limit:
            raise ValueError(
                f"bounded decision context exceeds {limit} bytes"
            )
        return context, {
            "actions": action_aliases,
            "statements": statement_aliases,
            "traversals": traversal_aliases,
            "probes": probe_aliases,
        }

    def _view(
        self,
        state: dict[str, Any],
        *,
        since_revision: int | None = None,
        focus_traversal_id: str | None = None,
    ) -> dict[str, object]:
        active_action_ids = set(state.get("active_action_ids", ()))
        available_actions = [
            branch["public"]
            for action_id, branch in state["branches"].items()
            if branch["status"] == "AVAILABLE"
            and action_id in active_action_ids
        ]
        seeds = list(
            dict.fromkeys(
                (
                    *state.get("active_focus_node_ids", ()),
                    *state.get("probe_focus_node_ids", ()),
                    state.get("manifestation_node_id"),
                )
            )
        )
        adjacency: dict[str, set[str]] = defaultdict(set)
        for edge in state["graph_edges"]:
            adjacency[edge["source"]].add(edge["target"])
            adjacency[edge["target"]].add(edge["source"])
        focused_ids_ordered: list[str] = []
        queue = deque(
            node_id
            for node_id in seeds
            if node_id in state["graph_nodes"]
        )
        seen: set[str] = set()
        while queue and len(focused_ids_ordered) < _GRAPH_NODE_LIMIT:
            node_id = queue.popleft()
            if node_id in seen or node_id not in state["graph_nodes"]:
                continue
            seen.add(node_id)
            focused_ids_ordered.append(node_id)
            queue.extend(
                sorted(
                    adjacency.get(node_id, ()),
                    key=lambda value: (
                        -int(state["node_distances"].get(value, -1)),
                        value,
                    ),
                )
            )
        focused = sorted(
            (
                state["graph_nodes"][node_id]
                for node_id in focused_ids_ordered
            ),
            key=lambda value: (
                0
                if value["node_id"]
                in set(state.get("active_focus_node_ids", ()))
                else 1,
                -int(
                    state["node_distances"].get(value["node_id"], 0)
                ),
                value["file"],
                value["line"],
            ),
        )
        focused_ids = {value["node_id"] for value in focused}
        focused_edges = [
            edge
            for edge in state["graph_edges"]
            if edge["source"] in focused_ids and edge["target"] in focused_ids
        ]
        projections = build_graph_projections(
            nodes=focused,
            edges=focused_edges,
            collapsed_functions=state["collapsed_functions"].values(),
            branches=state["branches"].values(),
            traversals=state["traversals"].values(),
            manifestation_node_id=state.get("manifestation_node_id"),
            focus_node_ids=state.get(
                "active_focus_node_ids", state["focus_node_ids"]
            ),
            focus_traversal_ids=state.get(
                "active_focus_traversal_ids",
                state.get("focus_traversal_ids", ()),
            ),
        )
        function_region_ids = {
            function_id: region["region_id"]
            for region in projections["function"]["regions"]
            for function_id in region.get("member_function_ids", ())
        }
        priority_traversal_ids = list(
            dict.fromkeys(
                (
                    *state.get("probe_focus_traversal_ids", ()),
                    *(
                        branch.get("meta", {}).get("sourceTraversalId")
                        for branch in state["branches"].values()
                        if branch.get("status") == "AVAILABLE"
                    ),
                    *state.get("focus_traversal_ids", ()),
                    state.get("manifestation_traversal_id"),
                )
            )
        )
        visible_traversal_ids = {
            traversal_id
            for traversal_id in priority_traversal_ids[
                -_TRAVERSAL_VIEW_LIMIT:
            ]
            if traversal_id in state["traversals"]
        }
        runtime_traversals = [
            {
                **traversal,
                "function_region_id": function_region_ids.get(
                    traversal["function_id"]
                ),
            }
            for traversal in sorted(
                (
                    state["traversals"][traversal_id]
                    for traversal_id in visible_traversal_ids
                ),
                key=lambda value: (
                    int(value.get("depth", 0)),
                    str(value["traversal_id"]),
                ),
            )
        ]
        if focus_traversal_id is not None:
            if focus_traversal_id not in state["traversals"]:
                raise ValueError(
                    f"unknown runtime traversal {focus_traversal_id}"
                )
            wanted = {focus_traversal_id}
            queue = [focus_traversal_id]
            while queue:
                current = queue.pop()
                for parent in state["traversals"][current].get(
                    "parent_traversal_ids", ()
                ):
                    if parent in state["traversals"] and parent not in wanted:
                        wanted.add(parent)
                        queue.append(parent)
            runtime_traversals = [
                {
                    **state["traversals"][traversal_id],
                    "function_region_id": function_region_ids.get(
                        state["traversals"][traversal_id]["function_id"]
                    ),
                }
                for traversal_id in sorted(wanted)
            ]
        public_focused = [
            {key: value for key, value in node.items() if key != "source"}
            for node in focused
        ]
        compact_dossiers = [
            {
                key: (
                    self._compact_evidence_value(value)
                    if key == "value"
                    else value
                )
                for key, value in dossier.items()
                if key not in {"coverage_notes"}
            }
            for dossier in state["dossiers"][-20:]
        ]
        view: dict[str, Any] = {
            "investigation_id": state["investigation_id"],
            "revision": int(state.get("revision", 1)),
            "criterion": state["criterion"],
            "phase": state["phase"],
            "status": state["status"],
            "round": state["round"],
            "graph": {
                "nodes": public_focused,
                "edges": focused_edges,
                "collapsedFunctions": list(
                    state["collapsed_functions"].values()
                ),
                "projections": projections,
                "runtimeTraversalVersion": 1,
                "runtimeTraversals": runtime_traversals,
                "runtimeTraversalSummary": {
                    "total": len(state["traversals"]),
                    "returned": len(runtime_traversals),
                },
                "manifestationTraversalId": state.get(
                    "manifestation_traversal_id"
                ),
                "unresolvedBranches": sum(
                    branch["status"] == "AVAILABLE"
                    for branch in state["branches"].values()
                ),
            },
            "probe_bundle": state.get("probe_bundle"),
            "value_dossiers": compact_dossiers,
            "judgments": state["judgments"][-50:],
            "actions": available_actions,
            "mechanism_context": state.get("mechanism_context"),
            "candidate_mechanism": state.get("candidate_mechanism"),
            "coverage_notes": state["coverage_notes"],
            "decision_log": state["decision_log"][-50:],
            "stats": {
                **state["stats"],
                "expandedFunctions": len(state["expanded_functions"]),
                "graphNodes": len(state["graph_nodes"]),
                "graphEdges": len(state["graph_edges"]),
                "boundaryRegions": len(
                    projections["boundary"]["regions"]
                ),
                "functionRegions": len(
                    projections["function"]["regions"]
                ),
                "segmentRegions": len(
                    projections["segment"]["regions"]
                ),
                "runtimeTraversals": len(state["traversals"]),
            },
        }
        decision_context, decision_aliases = self._decision_context(
            state,
            projections,
            runtime_traversals,
            available_actions,
            compact_dossiers,
            since_revision=since_revision,
        )
        view["decision_context"] = decision_context
        view["decision_aliases"] = decision_aliases
        view["stats"]["decisionPacketBytes"] = len(
            json.dumps(decision_context, separators=(",", ":")).encode()
        )
        view["stats"]["viewBytes"] = len(
            json.dumps(view, separators=(",", ":")).encode()
        )
        return view
