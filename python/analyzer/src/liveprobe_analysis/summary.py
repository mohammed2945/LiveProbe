"""Compact function-port summaries for lazy incident graph expansion."""

from __future__ import annotations

from collections import defaultdict

from .model import (
    FlowNode,
    FunctionDependency,
    FunctionFragment,
    FunctionSummary,
)


def _matches(left: str, right: str) -> bool:
    return (
        left == right
        or left.startswith(right + ".")
        or right.startswith(left + ".")
    )


def build_function_summary(fragment: FunctionFragment) -> FunctionSummary:
    """Derive conservative output-to-input relations from a full fragment.

    The summary intentionally keeps unresolved leaves rather than pretending
    that every parameter affects every result.  Call results are represented
    as explicit ports so an incident can expand that function only when the
    result is on the active path.
    """

    nodes = {node.node_id: node for node in fragment.nodes}
    definitions: dict[str, list[FlowNode]] = defaultdict(list)
    control_by_target: dict[str, list[FlowNode]] = defaultdict(list)
    uncertain_targets: set[str] = set()
    for node in fragment.nodes:
        if node.kind == "Return":
            continue
        for path in node.defs:
            definitions[path].append(node)
    for edge in fragment.edges:
        if edge.kind == "CONTROL" and edge.source in nodes:
            control_by_target[edge.target].append(nodes[edge.source])
        if edge.certainty != "MUST":
            uncertain_targets.add(edge.target)

    calls_by_node = {
        call.node_id: call
        for call in fragment.calls
        if call.result_paths
    }
    parameters = set(fragment.parameters)
    globals_ = set(fragment.module_globals)

    def matching_definitions(path: str) -> list[FlowNode]:
        exact = definitions.get(path)
        if exact:
            return exact
        candidates = [
            node
            for definition, values in definitions.items()
            if _matches(path, definition)
            for node in values
        ]
        return candidates

    def resolve(path: str, seen: frozenset[str] = frozenset()) -> set[str]:
        if path in seen:
            return {f"$cycle:{path}"}
        root = path.split(".", 1)[0]
        if root in parameters:
            return {path}
        if root in globals_:
            return {f"$global:{path}"}
        candidates = matching_definitions(path)
        if not candidates:
            return {path}
        result: set[str] = set()
        for node in candidates:
            call = calls_by_node.get(node.node_id)
            if call is not None and any(
                _matches(path, result_path)
                for result_path in call.result_paths
            ):
                result.add(f"$call:{call.target}:{path}")
                continue
            matching = [
                dependencies
                for definition, dependencies in node.dependencies
                if _matches(path, definition)
            ]
            dependencies = (
                {dependency for values in matching for dependency in values}
                if matching
                else set(node.uses)
            )
            if not dependencies:
                result.add(path)
                continue
            for dependency in dependencies:
                result.update(resolve(dependency, seen | {path}))
        return result

    dependencies: list[FunctionDependency] = []
    returns = [node for node in fragment.nodes if node.kind == "Return"]
    for node in returns:
        outputs = (
            tuple(node.dependencies)
            if node.dependencies
            else (("return", tuple(node.uses)),)
        )
        controls = {
            use
            for control in control_by_target.get(node.node_id, ())
            for use in control.uses
        }
        for output_path, direct_inputs in outputs:
            inputs = {
                leaf
                for direct in direct_inputs
                for leaf in resolve(direct)
            }
            control_inputs = {
                leaf for direct in controls for leaf in resolve(direct)
            }
            candidate_definitions = [
                matching_definitions(path) for path in direct_inputs
            ]
            certainty = (
                "MAY"
                if node.node_id in uncertain_targets
                or any(len(values) > 1 for values in candidate_definitions)
                else "MUST"
            )
            dependencies.append(
                FunctionDependency(
                    output_path=output_path,
                    input_paths=tuple(sorted(inputs)),
                    control_paths=tuple(sorted(control_inputs)),
                    certainty=certainty,
                )
            )

    if not dependencies:
        dependencies.append(
            FunctionDependency(
                output_path="return",
                input_paths=(),
                certainty="UNKNOWN",
            )
        )

    return FunctionSummary(
        function_id=fragment.function_id,
        file=fragment.file,
        qualified_name=fragment.qualified_name,
        start_line=fragment.start_line,
        end_line=fragment.end_line,
        parameters=fragment.parameters,
        dependencies=tuple(dependencies),
        calls=fragment.calls,
        routes=fragment.routes,
        durable_accesses=fragment.durable_accesses,
        module_globals=fragment.module_globals,
        coverage_notes=fragment.coverage_notes,
    )
