"""Language-neutral records emitted by the Python analysis frontend."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

EdgeKind = Literal[
    "CFG",
    "DATA",
    "CONTROL",
    "CALL_RETURN",
    "HTTP_BOUNDARY",
    "DURABLE_BOUNDARY",
    "MEMORY_MAY",
    "UNKNOWN",
]

CallContributionRole = Literal[
    "VALUE_PRODUCER",
    "CONTROL_GUARD",
    "ACTIVATION_SOURCE",
    "HISTORICAL_STATE_PRODUCER",
]


@dataclass(frozen=True, slots=True)
class FlowNode:
    node_id: str
    kind: str
    file: str
    function_id: str
    line: int
    end_line: int
    source: str
    defs: tuple[str, ...] = ()
    uses: tuple[str, ...] = ()
    dependencies: tuple[tuple[str, tuple[str, ...]], ...] = ()
    probe_line: int | None = None
    synthetic: bool = False


@dataclass(frozen=True, slots=True)
class FlowEdge:
    source: str
    target: str
    kind: EdgeKind
    variable: str | None = None
    certainty: Literal["MUST", "MAY", "UNKNOWN"] = "MUST"
    detail: str | None = None
    edge_id: str | None = None


RegionLevel = Literal["BOUNDARY", "FUNCTION", "SEGMENT", "STATEMENT"]
RegionKind = Literal[
    "OWNER",
    "RESOURCE",
    "FUNCTION",
    "TRANSFORM",
    "DECISION",
    "STATE",
    "BOUNDARY",
    "CALL",
    "CYCLE",
    "UNKNOWN",
]


@dataclass(frozen=True, slots=True)
class DependenceRegion:
    """A lossless projection over canonical dependence-graph members."""

    region_id: str
    level: RegionLevel
    kind: RegionKind
    label: str
    # Static source projections are deliberately owner-neutral. This field is
    # populated only for runtime boundary/resource regions.
    runtime_owner: str | None = None
    member_node_ids: tuple[str, ...] = ()
    member_function_ids: tuple[str, ...] = ()
    input_paths: tuple[str, ...] = ()
    output_paths: tuple[str, ...] = ()
    control_paths: tuple[str, ...] = ()
    entry_node_ids: tuple[str, ...] = ()
    exit_node_ids: tuple[str, ...] = ()
    certainty: Literal["MUST", "MAY", "UNKNOWN"] = "MUST"
    boundary_refs: tuple[str, ...] = ()
    coverage_notes: tuple[str, ...] = ()
    child_region_ids: tuple[str, ...] = ()
    expansion_state: Literal["COLLAPSED", "PARTIAL", "EXPANDED"] = "COLLAPSED"


@dataclass(frozen=True, slots=True)
class RegionEdge:
    """Bundled canonical edges between two projected regions."""

    edge_id: str
    source_region_id: str
    target_region_id: str
    edge_kinds: tuple[EdgeKind, ...]
    variable_paths: tuple[str, ...] = ()
    certainty: Literal["MUST", "MAY", "UNKNOWN"] = "MUST"
    supporting_edge_count: int = 1


@dataclass(frozen=True, slots=True)
class GraphProjection:
    level: RegionLevel
    regions: tuple[DependenceRegion, ...]
    edges: tuple[RegionEdge, ...]
    focus_region_ids: tuple[str, ...] = ()
    frontier_region_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Hammock:
    hammock_id: str
    function_id: str
    kind: str
    entry_node: str
    exit_nodes: tuple[str, ...]
    node_ids: tuple[str, ...]
    start_line: int
    end_line: int
    parent_id: str | None
    source: str
    coverage_notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CallSite:
    node_id: str
    target: str
    argument_paths: tuple[tuple[str, ...], ...]
    keyword_paths: tuple[tuple[str, tuple[str, ...]], ...]
    result_paths: tuple[str, ...]
    contribution_role: CallContributionRole = "VALUE_PRODUCER"
    boundary_kind: Literal["local", "http", "durable", "unknown"] = "local"
    boundary_detail: str | None = None


@dataclass(frozen=True, slots=True)
class RouteSummary:
    method: str
    path: str
    function_id: str
    parameter_fields: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DurableAccess:
    node_id: str
    operation: Literal["read", "write", "unknown"]
    resource: str
    fields: tuple[str, ...]
    key_fields: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FunctionFragment:
    function_id: str
    file: str
    qualified_name: str
    start_line: int
    end_line: int
    parameters: tuple[str, ...]
    entry_node: str
    exit_node: str
    nodes: tuple[FlowNode, ...]
    edges: tuple[FlowEdge, ...]
    hammocks: tuple[Hammock, ...]
    calls: tuple[CallSite, ...]
    routes: tuple[RouteSummary, ...] = ()
    durable_accesses: tuple[DurableAccess, ...] = ()
    module_globals: tuple[str, ...] = ()
    coverage_notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> FunctionFragment:
        return cls(
            function_id=str(raw["function_id"]),
            file=str(raw["file"]),
            qualified_name=str(raw["qualified_name"]),
            start_line=int(raw["start_line"]),
            end_line=int(raw["end_line"]),
            parameters=tuple(str(value) for value in raw["parameters"]),
            entry_node=str(raw["entry_node"]),
            exit_node=str(raw["exit_node"]),
            nodes=tuple(
                FlowNode(
                    **{
                        **value,
                        "defs": tuple(value.get("defs", ())),
                        "uses": tuple(value.get("uses", ())),
                        "dependencies": tuple(
                            (
                                str(definition),
                                tuple(str(path) for path in paths),
                            )
                            for definition, paths in value.get(
                                "dependencies", ()
                            )
                        ),
                    }
                )
                for value in raw["nodes"]
            ),
            edges=tuple(FlowEdge(**value) for value in raw["edges"]),
            hammocks=tuple(
                Hammock(
                    **{
                        **value,
                        "exit_nodes": tuple(value["exit_nodes"]),
                        "node_ids": tuple(value["node_ids"]),
                        "coverage_notes": tuple(
                            value.get("coverage_notes", ())
                        ),
                    }
                )
                for value in raw["hammocks"]
            ),
            calls=tuple(
                CallSite(
                    node_id=str(value["node_id"]),
                    target=str(value["target"]),
                    argument_paths=tuple(
                        tuple(str(path) for path in paths)
                        for paths in value["argument_paths"]
                    ),
                    keyword_paths=tuple(
                        (str(name), tuple(str(path) for path in paths))
                        for name, paths in value["keyword_paths"]
                    ),
                    result_paths=tuple(
                        str(path) for path in value["result_paths"]
                    ),
                    contribution_role=value.get(
                        "contribution_role", "VALUE_PRODUCER"
                    ),
                    boundary_kind=value.get("boundary_kind", "local"),
                    boundary_detail=value.get("boundary_detail"),
                )
                for value in raw["calls"]
            ),
            routes=tuple(
                RouteSummary(
                    **{
                        **value,
                        "parameter_fields": tuple(value["parameter_fields"]),
                    }
                )
                for value in raw.get("routes", [])
            ),
            durable_accesses=tuple(
                DurableAccess(
                    **{
                        **value,
                        "fields": tuple(value["fields"]),
                        "key_fields": tuple(value["key_fields"]),
                    }
                )
                for value in raw.get("durable_accesses", [])
            ),
            module_globals=tuple(
                str(value) for value in raw.get("module_globals", [])
            ),
            coverage_notes=tuple(
                str(value) for value in raw.get("coverage_notes", [])
            ),
        )


@dataclass(frozen=True, slots=True)
class AnalysisCriterion:
    repository_root: str
    commit: str
    service_id: str
    file: str
    line: int
    watch_path: str | None = None
    expression: str | None = None
    probe_budget: int = 5
    source_roots: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ProbeCandidate:
    candidate_id: str
    function_id: str
    hammock_id: str
    file: str
    line: int
    watch_paths: tuple[str, ...]
    distance_from_sink: int
    upstream_weight: int
    reason: str
    certainty: Literal["MUST", "MAY", "UNKNOWN"]


@dataclass(frozen=True, slots=True)
class AnalysisPlan:
    plan_id: str
    criterion: AnalysisCriterion
    slice_node_ids: tuple[str, ...]
    slice_edges: tuple[FlowEdge, ...]
    hammocks: tuple[Hammock, ...]
    frontier: tuple[ProbeCandidate, ...]
    coverage_notes: tuple[str, ...]
    round: int = 1
    status: Literal["ACTIVE", "LOCALIZED", "EXONERATED", "INSUFFICIENT"] = (
        "ACTIVE"
    )
    likely_hammock_id: str | None = None
    stats: dict[str, int | float | str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class CandidateAssessment:
    candidate_id: str
    classification: Literal["good", "bad", "unknown"]
    occurrence_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class FunctionDependency:
    """A compact relation retained when a function body is not materialized."""

    output_path: str
    input_paths: tuple[str, ...]
    control_paths: tuple[str, ...] = ()
    certainty: Literal["MUST", "MAY", "UNKNOWN"] = "MUST"


@dataclass(frozen=True, slots=True)
class FunctionSummary:
    """Function-level ports and effects used by the lazy investigation graph."""

    function_id: str
    file: str
    qualified_name: str
    start_line: int
    end_line: int
    parameters: tuple[str, ...]
    dependencies: tuple[FunctionDependency, ...]
    calls: tuple[CallSite, ...]
    routes: tuple[RouteSummary, ...] = ()
    durable_accesses: tuple[DurableAccess, ...] = ()
    module_globals: tuple[str, ...] = ()
    coverage_notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> FunctionSummary:
        return cls(
            function_id=str(raw["function_id"]),
            file=str(raw["file"]),
            qualified_name=str(raw["qualified_name"]),
            start_line=int(raw["start_line"]),
            end_line=int(raw["end_line"]),
            parameters=tuple(str(value) for value in raw["parameters"]),
            dependencies=tuple(
                FunctionDependency(
                    output_path=str(value["output_path"]),
                    input_paths=tuple(
                        str(path) for path in value.get("input_paths", ())
                    ),
                    control_paths=tuple(
                        str(path) for path in value.get("control_paths", ())
                    ),
                    certainty=value.get("certainty", "MUST"),
                )
                for value in raw.get("dependencies", ())
            ),
            calls=tuple(
                CallSite(
                    node_id=str(value["node_id"]),
                    target=str(value["target"]),
                    argument_paths=tuple(
                        tuple(str(path) for path in paths)
                        for paths in value["argument_paths"]
                    ),
                    keyword_paths=tuple(
                        (str(name), tuple(str(path) for path in paths))
                        for name, paths in value["keyword_paths"]
                    ),
                    result_paths=tuple(
                        str(path) for path in value["result_paths"]
                    ),
                    contribution_role=value.get(
                        "contribution_role", "VALUE_PRODUCER"
                    ),
                    boundary_kind=value.get("boundary_kind", "local"),
                    boundary_detail=value.get("boundary_detail"),
                )
                for value in raw.get("calls", ())
            ),
            routes=tuple(
                RouteSummary(
                    method=str(value["method"]),
                    path=str(value["path"]),
                    function_id=str(value["function_id"]),
                    parameter_fields=tuple(
                        str(path) for path in value.get("parameter_fields", ())
                    ),
                )
                for value in raw.get("routes", ())
            ),
            durable_accesses=tuple(
                DurableAccess(
                    node_id=str(value["node_id"]),
                    operation=value["operation"],
                    resource=str(value["resource"]),
                    fields=tuple(str(path) for path in value.get("fields", ())),
                    key_fields=tuple(
                        str(path) for path in value.get("key_fields", ())
                    ),
                )
                for value in raw.get("durable_accesses", ())
            ),
            module_globals=tuple(
                str(value) for value in raw.get("module_globals", ())
            ),
            coverage_notes=tuple(
                str(value) for value in raw.get("coverage_notes", ())
            ),
        )


@dataclass(frozen=True, slots=True)
class InvestigationCriterion:
    repository_root: str
    commit: str
    service_id: str
    file: str
    line: int
    symptom: str
    watch_path: str | None = None
    expression: str | None = None
    failure_class: Literal[
        "type_shape",
        "domain_range",
        "contract",
        "semantic",
        "absence",
    ] = "semantic"
    expected_type: Literal[
        "numeric", "string", "boolean", "mapping", "sequence"
    ] | None = None
    minimum: float | None = None
    maximum: float | None = None
    minimum_exclusive: bool = False
    maximum_exclusive: bool = False
    probe_budget: int = 5
    source_roots: tuple[str, ...] = ()
    ownership_map: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class InvestigationAction:
    action_id: str
    kind: Literal[
        "FOLLOW_PATH",
        "PROBE_REGION",
        "INSPECT_MECHANISM",
        "CONFIRM_CANDIDATE",
        "COMPLETE_LOCALIZATION",
        "HANDOFF_BOUNDARY",
    ]
    label: str
    reason: str
    function_id: str | None = None
    anchor_node_id: str | None = None
    tracked_paths: tuple[str, ...] = ()
    boundary_kind: str | None = None
    estimated_nodes: int = 0
    source_traversal_id: str | None = None
    target_service_id: str | None = None
    region_id: str | None = None
    dependency_role: CallContributionRole | None = None


@dataclass(frozen=True, slots=True)
class TraversalHop:
    """One provenance edge by which a runtime traversal reached source."""

    parent_traversal_id: str
    via_node_id: str
    edge_ids: tuple[str, ...] = ()
    boundary_kind: str | None = None
    boundary_detail: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeTraversal:
    """Runtime path context pointing at one canonical source function."""

    traversal_id: str
    function_id: str
    service_id: str
    anchor_node_ids: tuple[str, ...]
    tracked_paths: tuple[str, ...]
    member_node_ids: tuple[str, ...] = ()
    parent_traversal_ids: tuple[str, ...] = ()
    incoming_hops: tuple[TraversalHop, ...] = ()
    depth: int = 0
    status: Literal["ACTIVE", "EXPANDED", "ARCHIVED"] = "ACTIVE"


@dataclass(frozen=True, slots=True)
class InvestigationProbeSite:
    site_id: str
    node_id: str
    function_id: str
    file: str
    line: int
    watch_paths: tuple[str, ...]
    reason: str
    certainty: Literal["MUST", "MAY", "UNKNOWN"]
    service_id: str
    traversal_ids: tuple[str, ...]
    path_node_ids: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class ProbeBundle:
    bundle_id: str
    round: int
    sites: tuple[InvestigationProbeSite, ...]
    reason: str


@dataclass(frozen=True, slots=True)
class ValueObservation:
    observation_id: str
    site_id: str
    occurrence_id: str
    hit_index: int
    values: dict[str, object]
    sequence_index: int | None = None
    timestamp: str | None = None
    service_instance: str | None = None
    capture_status: Literal["complete", "truncated", "dropped"] = "complete"


@dataclass(frozen=True, slots=True)
class ValueJudgment:
    judgment_id: str
    dossier_id: str
    classification: Literal[
        "VIOLATES", "CONSISTENT", "SUSPICIOUS", "UNKNOWN"
    ]
    basis: Literal["MECHANICAL"]
    defeasible: bool
    evidence_refs: tuple[str, ...]
    rationale: str


@dataclass(frozen=True, slots=True)
class ValueDossier:
    dossier_id: str
    site_id: str
    watch_path: str
    symptom: str
    location: str
    function_id: str
    service_id: str
    traversal_ids: tuple[str, ...]
    value: object
    evidence_ref: str
    occurrence_id: str
    hit_index: int
    causal_path: tuple[str, ...]
    interpretation: Literal[
        "VIOLATES", "CONSISTENT", "SUSPICIOUS", "UNKNOWN"
    ] = "UNKNOWN"
    sequence_index: int | None = None
    sequence_scope: str | None = None
    timestamp: str | None = None
    static_certainty: Literal["MUST", "MAY", "UNKNOWN"] = "UNKNOWN"
    capture_status: str = "complete"
    coverage_notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class InvestigationDecision:
    action_ids: tuple[str, ...]
    based_on_revision: int | None = None
    exploration_question: str | None = None
    candidate_mechanism: CandidateMechanism | None = None
    evidence_refs: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CandidatePrediction:
    probe_candidate_id: str
    watch_path: str
    operator: Literal["eq", "ne", "truthy", "falsy", "present"]
    expected_value: object | None = None


@dataclass(frozen=True, slots=True)
class CandidateMechanism:
    statement: str
    anchor_node_ids: tuple[str, ...]
    traversal_id: str
    predictions: tuple[CandidatePrediction, ...]
