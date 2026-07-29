"""Python AST frontend for cached function-local analysis fragments."""

from __future__ import annotations

import ast
import hashlib
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

from .boundaries import classify_boundary_call, discover_client_bindings
from .model import (
    CallContributionRole,
    CallSite,
    DurableAccess,
    FlowEdge,
    FlowNode,
    FunctionFragment,
    Hammock,
    RouteSummary,
)

_KNOWN_MUTATORS = frozenset(
    {
        "add",
        "append",
        "clear",
        "difference_update",
        "discard",
        "extend",
        "insert",
        "intersection_update",
        "pop",
        "remove",
        "reverse",
        "setdefault",
        "sort",
        "symmetric_difference_update",
        "update",
    }
)


def _digest(*parts: object) -> str:
    payload = "\0".join(str(part) for part in parts).encode()
    return hashlib.sha256(payload).hexdigest()[:20]


def _source_segment(source: str, node: ast.AST) -> str:
    return (ast.get_source_segment(source, node) or "").strip()


def _bounded_source(value: str, limit: int = 16_000) -> tuple[str, bool]:
    if len(value) <= limit:
        return value, False
    half = (limit - 64) // 2
    return (
        value[:half]
        + "\n# ... LiveProbe hammock source truncated ...\n"
        + value[-half:],
        True,
    )


def _attribute_path(node: ast.AST) -> str | None:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
        return ".".join(reversed(parts))
    if isinstance(current, ast.Subscript):
        base = _attribute_path(current.value)
        if base is None:
            return None
        key = current.slice
        if isinstance(key, ast.Constant) and isinstance(key.value, (str, int)):
            return f"{base}.{key.value}"
    if isinstance(current, ast.Name):
        return current.id
    return None


def _target_paths(node: ast.AST) -> set[str]:
    if isinstance(node, (ast.Tuple, ast.List)):
        result: set[str] = set()
        for element in node.elts:
            result.update(_target_paths(element))
        return result
    path = _attribute_path(node)
    return {path} if path is not None else set()


class _UseVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.paths: set[str] = set()

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.paths.add(node.id)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.ctx, ast.Load):
            path = _attribute_path(node)
            if path:
                self.paths.add(path)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if isinstance(node.ctx, ast.Load):
            path = _attribute_path(node)
            if path:
                self.paths.add(path)
        self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        return

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return


def _uses(node: ast.AST | None) -> set[str]:
    if node is None:
        return set()
    visitor = _UseVisitor()
    visitor.visit(node)
    return visitor.paths


def expression_paths(expression: str) -> tuple[str, ...]:
    """Return the conservative variable paths referenced by an expression."""

    parsed = ast.parse(expression, mode="eval")
    return tuple(sorted(_uses(parsed.body)))


def _statement_defs_uses(node: ast.stmt) -> tuple[set[str], set[str]]:
    definitions: set[str] = set()
    relevant: list[ast.AST] = []
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            definitions.update(_target_paths(target))
        relevant.append(node.value)
    elif isinstance(node, ast.AugAssign):
        definitions.update(_target_paths(node.target))
        relevant.extend([node.target, node.value])
    elif isinstance(node, (ast.For, ast.AsyncFor)):
        definitions.update(_target_paths(node.target))
        relevant.append(node.iter)
    elif isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            relevant.append(item.context_expr)
            if item.optional_vars:
                definitions.update(_target_paths(item.optional_vars))
    elif isinstance(node, ast.If):
        relevant.append(node.test)
    elif isinstance(node, ast.While):
        relevant.append(node.test)
    elif isinstance(node, ast.Return):
        relevant.append(node.value)
    elif isinstance(node, ast.Raise):
        relevant.extend([node.exc, node.cause])
    elif isinstance(node, ast.Expr):
        relevant.append(node.value)
    elif isinstance(node, ast.Assert):
        relevant.extend([node.test, node.msg])
    elif isinstance(node, ast.Delete):
        relevant.extend(node.targets)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        definitions.add(node.name)
        relevant.extend(node.decorator_list)
    elif isinstance(node, ast.Import):
        definitions.update(alias.asname or alias.name.split(".", 1)[0] for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
        definitions.update(alias.asname or alias.name for alias in node.names)
    elif isinstance(node, ast.Match):
        relevant.append(node.subject)
    elif isinstance(node, ast.Try):
        pass
    else:
        relevant.append(node)
    used: set[str] = set()
    for item in relevant:
        used.update(_uses(item))
    for child in _calls_in_statement(node):
        if (
            isinstance(child.func, ast.Attribute)
            and child.func.attr in _KNOWN_MUTATORS
        ):
            receiver = _attribute_path(child.func.value)
            if receiver is not None:
                definitions.add(receiver)
    return definitions, used


def _statement_dependencies(
    node: ast.stmt,
    definitions: set[str],
    used: set[str],
) -> tuple[set[str], tuple[tuple[str, tuple[str, ...]], ...]]:
    dependencies: dict[str, set[str]] = {
        definition: set(used) for definition in definitions
    }
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        value = node.value
        if len(targets) == 1 and isinstance(value, ast.Dict):
            roots = _target_paths(targets[0])
            if len(roots) == 1:
                root = next(iter(roots))
                for key, item in zip(value.keys, value.values, strict=True):
                    if isinstance(key, ast.Constant) and isinstance(
                        key.value, (str, int)
                    ):
                        field = f"{root}.{key.value}"
                        definitions.add(field)
                        dependencies[field] = _uses(item)
    elif isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
        for key, item in zip(node.value.keys, node.value.values, strict=True):
            if isinstance(key, ast.Constant) and isinstance(
                key.value, (str, int)
            ):
                field = str(key.value)
                definitions.add(field)
                dependencies[field] = _uses(item)
    return definitions, tuple(
        (definition, tuple(sorted(values)))
        for definition, values in sorted(dependencies.items())
    )


def _call_name(node: ast.Call) -> str:
    path = _attribute_path(node.func)
    if path:
        return path
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    if isinstance(node.func, ast.Name):
        return node.func.id
    return "<dynamic>"


def _calls_in_statement(node: ast.stmt) -> Iterator[ast.Call]:
    class Calls(ast.NodeVisitor):
        def __init__(self) -> None:
            self.values: list[ast.Call] = []

        def visit_Call(self, call: ast.Call) -> None:
            self.values.append(call)
            self.generic_visit(call)

        def visit_If(self, child: ast.If) -> None:
            self.visit(child.test)

        def visit_While(self, child: ast.While) -> None:
            self.visit(child.test)

        def visit_For(self, child: ast.For) -> None:
            self.visit(child.iter)

        def visit_AsyncFor(self, child: ast.AsyncFor) -> None:
            self.visit(child.iter)

        def visit_With(self, child: ast.With) -> None:
            for item in child.items:
                self.visit(item.context_expr)

        def visit_AsyncWith(self, child: ast.AsyncWith) -> None:
            for item in child.items:
                self.visit(item.context_expr)

        def visit_Try(self, child: ast.Try) -> None:
            for handler in child.handlers:
                if handler.type is not None:
                    self.visit(handler.type)

        def visit_Match(self, child: ast.Match) -> None:
            self.visit(child.subject)
            for case in child.cases:
                if case.guard is not None:
                    self.visit(case.guard)

        def visit_FunctionDef(self, child: ast.FunctionDef) -> None:
            for decorator in child.decorator_list:
                self.visit(decorator)
            for default in child.args.defaults + child.args.kw_defaults:
                if default is not None:
                    self.visit(default)

        def visit_AsyncFunctionDef(self, child: ast.AsyncFunctionDef) -> None:
            self.visit_FunctionDef(child)

        def visit_ClassDef(self, child: ast.ClassDef) -> None:
            for decorator in child.decorator_list:
                self.visit(decorator)
            for base in child.bases:
                self.visit(base)

    visitor = Calls()
    visitor.visit(node)
    yield from visitor.values


def _contains_ast(root: ast.AST | None, wanted: ast.AST) -> bool:
    return root is not None and any(node is wanted for node in ast.walk(root))


def _call_contribution_role(
    statement: ast.stmt, call: ast.Call
) -> CallContributionRole:
    """Classify how a call contributes without guessing domain semantics.

    This is deliberately syntactic. Calls in predicates select whether a
    value-producing branch executes; calls in branch bodies and ordinary
    expressions still produce values.
    """

    predicate_roots: list[ast.AST | None] = []
    if isinstance(statement, (ast.If, ast.While, ast.Assert)):
        predicate_roots.append(statement.test)
    elif isinstance(statement, (ast.For, ast.AsyncFor)):
        predicate_roots.append(statement.iter)
    elif isinstance(statement, ast.Match):
        predicate_roots.extend(
            case.guard for case in statement.cases if case.guard is not None
        )
    for node in ast.walk(statement):
        if isinstance(node, ast.IfExp):
            predicate_roots.append(node.test)
        elif isinstance(node, ast.comprehension):
            predicate_roots.extend(node.ifs)
    if any(_contains_ast(root, call) for root in predicate_roots):
        return "CONTROL_GUARD"
    return "VALUE_PRODUCER"


def _literal_string(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _import_aliases(
    tree: ast.Module, relative: str
) -> dict[str, str]:
    module = relative.removesuffix(".py").replace("/", ".")
    package_parts = module.split(".")[:-1]
    aliases: dict[str, str] = {}
    for statement in tree.body:
        if isinstance(statement, ast.Import):
            for imported in statement.names:
                local = imported.asname or imported.name.split(".", 1)[0]
                aliases[local] = imported.name if imported.asname else local
        elif isinstance(statement, ast.ImportFrom):
            prefix_parts = list(package_parts)
            if statement.level:
                remove = max(0, statement.level - 1)
                prefix_parts = (
                    prefix_parts[: len(prefix_parts) - remove]
                    if remove
                    else prefix_parts
                )
            else:
                prefix_parts = []
            if statement.module:
                prefix_parts.extend(statement.module.split("."))
            prefix = ".".join(prefix_parts)
            for imported in statement.names:
                if imported.name == "*":
                    continue
                local = imported.asname or imported.name
                aliases[local] = (
                    f"{prefix}.{imported.name}" if prefix else imported.name
                )
    return aliases


def _resolve_imported_target(
    target: str, aliases: dict[str, str]
) -> str:
    root, separator, remainder = target.partition(".")
    resolved = aliases.get(root)
    if resolved is None:
        return target
    return resolved + (separator + remainder if separator else "")


def _dict_keys(node: ast.AST | None) -> tuple[str, ...]:
    if not isinstance(node, ast.Dict):
        return ()
    return tuple(
        str(key.value)
        for key in node.keys
        if isinstance(key, ast.Constant) and isinstance(key.value, (str, int))
    )


@dataclass(slots=True)
class _Cfg:
    successors: dict[str, set[str]]
    predecessors: dict[str, set[str]]

    @classmethod
    def empty(cls) -> _Cfg:
        return cls(defaultdict(set), defaultdict(set))

    def add(self, source: str, target: str) -> None:
        self.successors[source].add(target)
        self.predecessors[target].add(source)


class PythonFrontend:
    """Extract deterministic, conservative fragments from Python source."""

    def analyze_file(self, path: Path, repository_root: Path) -> list[FunctionFragment]:
        source = path.read_text(encoding="utf-8")
        relative = path.relative_to(repository_root).as_posix()
        return self.analyze_source(source, relative)

    def analyze_source(
        self, source: str, relative: str
    ) -> list[FunctionFragment]:
        tree = ast.parse(source, filename=relative, type_comments=True)
        parents: dict[ast.AST, ast.AST] = {}
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                parents[child] = parent
        import_aliases = _import_aliases(tree, relative)
        module_globals: set[str] = set()
        for statement in tree.body:
            if isinstance(statement, (ast.Assign, ast.AnnAssign)):
                targets = (
                    statement.targets
                    if isinstance(statement, ast.Assign)
                    else [statement.target]
                )
                for target in targets:
                    module_globals.update(_target_paths(target))

        fragments: list[FunctionFragment] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                fragments.append(
                    self._analyze_function(
                        node,
                        relative,
                        source,
                        parents,
                        tuple(sorted(module_globals)),
                        import_aliases,
                    )
                )
        return fragments

    def _analyze_function(
        self,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        file: str,
        source: str,
        parents: dict[ast.AST, ast.AST],
        module_globals: tuple[str, ...],
        import_aliases: dict[str, str],
    ) -> FunctionFragment:
        qualified = self._qualified_name(function, parents)
        function_id = f"py:{file}:{qualified}:{function.lineno}"
        entry_id = f"{function_id}:entry"
        exit_id = f"{function_id}:exit"
        parameters = tuple(
            argument.arg
            for argument in (
                list(function.args.posonlyargs)
                + list(function.args.args)
                + list(function.args.kwonlyargs)
            )
        )
        if function.args.vararg:
            parameters += (function.args.vararg.arg,)
        if function.args.kwarg:
            parameters += (function.args.kwarg.arg,)

        statement_nodes = list(self._statements(function.body))
        ast_to_id = {
            statement: f"{function_id}:n:{statement.lineno}:{index}"
            for index, statement in enumerate(statement_nodes)
        }
        cfg = _Cfg.empty()
        self._connect_sequence(
            function.body,
            exit_id,
            cfg,
            ast_to_id,
            break_target=exit_id,
            continue_target=entry_id,
            return_target=exit_id,
        )
        first = self._first_node(function.body, ast_to_id) or exit_id
        cfg.add(entry_id, first)

        node_records: list[FlowNode] = [
            FlowNode(
                node_id=entry_id,
                kind="entry",
                file=file,
                function_id=function_id,
                line=function.lineno,
                end_line=function.lineno,
                source=f"def {qualified}(...)",
                defs=parameters,
                synthetic=True,
            ),
            FlowNode(
                node_id=exit_id,
                kind="exit",
                file=file,
                function_id=function_id,
                line=getattr(function, "end_lineno", function.lineno),
                end_line=getattr(function, "end_lineno", function.lineno),
                source="<function exit>",
                synthetic=True,
            ),
        ]
        defs_by_node: dict[str, set[str]] = {entry_id: set(parameters), exit_id: set()}
        uses_by_node: dict[str, set[str]] = {entry_id: set(), exit_id: set()}
        coverage: set[str] = set()
        for statement in statement_nodes:
            node_id = ast_to_id[statement]
            definitions, used = _statement_defs_uses(statement)
            definitions, dependencies = _statement_dependencies(
                statement, definitions, used
            )
            defs_by_node[node_id] = definitions
            uses_by_node[node_id] = used
            if any(
                isinstance(child, (ast.Call, ast.Attribute))
                and (
                    isinstance(child, ast.Call)
                    and _call_name(child) in {"eval", "exec", "__import__"}
                )
                for child in ast.walk(statement)
            ):
                coverage.add(
                    f"{file}:{statement.lineno}: dynamic execution is unresolved"
                )
            node_records.append(
                FlowNode(
                    node_id=node_id,
                    kind=(
                        f"{type(statement).__name__}:conditional"
                        if any(
                            isinstance(child, ast.IfExp)
                            for child in ast.walk(statement)
                        )
                        else type(statement).__name__
                    ),
                    file=file,
                    function_id=function_id,
                    line=statement.lineno,
                    end_line=getattr(statement, "end_lineno", statement.lineno),
                    source=_source_segment(source, statement),
                    defs=tuple(sorted(definitions)),
                    uses=tuple(sorted(used)),
                    dependencies=dependencies,
                    probe_line=self._probe_line(
                        node_id, definitions, cfg, ast_to_id, statement_nodes
                    ),
                )
            )

        edges = [
            FlowEdge(source=source_id, target=target_id, kind="CFG")
            for source_id, targets in cfg.successors.items()
            for target_id in sorted(targets)
        ]
        edges.extend(
            self._reaching_definition_edges(
                entry_id,
                node_records,
                cfg,
                defs_by_node,
                uses_by_node,
            )
        )
        edges.extend(self._control_edges(statement_nodes, ast_to_id))
        edges.extend(self._memory_edges(node_records))
        edges = [
            FlowEdge(
                source=edge.source,
                target=edge.target,
                kind=edge.kind,
                variable=edge.variable,
                certainty=edge.certainty,
                detail=edge.detail,
                edge_id=(
                    "edge_"
                    + _digest(
                        function_id,
                        edge.source,
                        edge.target,
                        edge.kind,
                        edge.variable,
                        edge.certainty,
                        edge.detail,
                    )
                ),
            )
            for edge in edges
        ]

        calls, durable = self._call_summaries(
            statement_nodes,
            ast_to_id,
            source,
            defs_by_node,
            import_aliases,
        )
        routes = self._route_summaries(function, function_id, parents)
        hammocks = self._hammocks(
            function,
            function_id,
            file,
            source,
            ast_to_id,
            exit_id,
            coverage,
        )
        return FunctionFragment(
            function_id=function_id,
            file=file,
            qualified_name=qualified,
            start_line=function.lineno,
            end_line=getattr(function, "end_lineno", function.lineno),
            parameters=parameters,
            entry_node=entry_id,
            exit_node=exit_id,
            nodes=tuple(node_records),
            edges=tuple(edges),
            hammocks=tuple(hammocks),
            calls=tuple(calls),
            routes=tuple(routes),
            durable_accesses=tuple(durable),
            module_globals=module_globals,
            coverage_notes=tuple(sorted(coverage)),
        )

    def _qualified_name(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        parents: dict[ast.AST, ast.AST],
    ) -> str:
        names = [node.name]
        current = parents.get(node)
        while current is not None:
            if isinstance(
                current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                names.append(current.name)
            current = parents.get(current)
        return ".".join(reversed(names))

    def _statements(self, body: Iterable[ast.stmt]) -> Iterator[ast.stmt]:
        for statement in body:
            yield statement
            for child_body in self._child_bodies(statement):
                yield from self._statements(child_body)

    def _child_bodies(self, statement: ast.stmt) -> list[list[ast.stmt]]:
        result: list[list[ast.stmt]] = []
        if isinstance(statement, (ast.If, ast.For, ast.AsyncFor, ast.While)):
            result.extend([statement.body, statement.orelse])
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            result.append(statement.body)
        elif isinstance(statement, ast.Try):
            result.extend([statement.body, statement.orelse, statement.finalbody])
            result.extend(handler.body for handler in statement.handlers)
        elif isinstance(statement, ast.Match):
            result.extend(case.body for case in statement.cases)
        return [body for body in result if body]

    def _first_node(
        self, body: list[ast.stmt], ids: dict[ast.stmt, str]
    ) -> str | None:
        return ids[body[0]] if body else None

    def _connect_sequence(
        self,
        body: list[ast.stmt],
        follow: str,
        cfg: _Cfg,
        ids: dict[ast.stmt, str],
        *,
        break_target: str,
        continue_target: str,
        return_target: str,
    ) -> None:
        for index, statement in enumerate(body):
            next_id = ids[body[index + 1]] if index + 1 < len(body) else follow
            node_id = ids[statement]
            if isinstance(statement, (ast.Return, ast.Raise)):
                cfg.add(node_id, return_target)
                continue
            if isinstance(statement, ast.Break):
                cfg.add(node_id, break_target)
                continue
            if isinstance(statement, ast.Continue):
                cfg.add(node_id, continue_target)
                continue
            if isinstance(statement, ast.If):
                cfg.add(node_id, self._first_node(statement.body, ids) or next_id)
                cfg.add(node_id, self._first_node(statement.orelse, ids) or next_id)
                self._connect_sequence(
                    statement.body,
                    next_id,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                self._connect_sequence(
                    statement.orelse,
                    next_id,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                continue
            if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
                cfg.add(node_id, self._first_node(statement.body, ids) or node_id)
                after_loop = self._first_node(statement.orelse, ids) or next_id
                cfg.add(node_id, after_loop)
                self._connect_sequence(
                    statement.body,
                    node_id,
                    cfg,
                    ids,
                    break_target=next_id,
                    continue_target=node_id,
                    return_target=return_target,
                )
                self._connect_sequence(
                    statement.orelse,
                    next_id,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                continue
            if isinstance(statement, (ast.With, ast.AsyncWith)):
                cfg.add(node_id, self._first_node(statement.body, ids) or next_id)
                self._connect_sequence(
                    statement.body,
                    next_id,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                continue
            if isinstance(statement, ast.Try):
                entries = [self._first_node(statement.body, ids)]
                entries.extend(
                    self._first_node(handler.body, ids)
                    for handler in statement.handlers
                )
                for entry in entries:
                    cfg.add(node_id, entry or next_id)
                final_entry = self._first_node(statement.finalbody, ids) or next_id
                else_entry = self._first_node(statement.orelse, ids) or final_entry
                self._connect_sequence(
                    statement.body,
                    else_entry,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                self._connect_sequence(
                    statement.orelse,
                    final_entry,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                for handler in statement.handlers:
                    self._connect_sequence(
                        handler.body,
                        final_entry,
                        cfg,
                        ids,
                        break_target=break_target,
                        continue_target=continue_target,
                        return_target=return_target,
                    )
                self._connect_sequence(
                    statement.finalbody,
                    next_id,
                    cfg,
                    ids,
                    break_target=break_target,
                    continue_target=continue_target,
                    return_target=return_target,
                )
                continue
            if isinstance(statement, ast.Match):
                if not statement.cases:
                    cfg.add(node_id, next_id)
                for case in statement.cases:
                    cfg.add(node_id, self._first_node(case.body, ids) or next_id)
                    self._connect_sequence(
                        case.body,
                        next_id,
                        cfg,
                        ids,
                        break_target=break_target,
                        continue_target=continue_target,
                        return_target=return_target,
                    )
                continue
            cfg.add(node_id, next_id)

    def _reaching_definition_edges(
        self,
        entry_id: str,
        nodes: list[FlowNode],
        cfg: _Cfg,
        definitions: dict[str, set[str]],
        uses: dict[str, set[str]],
    ) -> list[FlowEdge]:
        node_ids = [node.node_id for node in nodes]
        incoming: dict[str, dict[str, set[str]]] = {
            node_id: defaultdict(set) for node_id in node_ids
        }
        outgoing: dict[str, dict[str, set[str]]] = {
            node_id: defaultdict(set) for node_id in node_ids
        }
        outgoing[entry_id] = defaultdict(
            set, {name: {entry_id} for name in definitions[entry_id]}
        )
        queue = deque(node_ids)
        while queue:
            node_id = queue.popleft()
            merged: dict[str, set[str]] = defaultdict(set)
            for predecessor in cfg.predecessors.get(node_id, set()):
                for variable, sources in outgoing.get(predecessor, {}).items():
                    merged[variable].update(sources)
            if node_id == entry_id:
                for variable in definitions[entry_id]:
                    merged[variable].add(entry_id)
            new_out = defaultdict(set)
            for variable, sources in merged.items():
                new_out[variable].update(sources)
            for variable in definitions.get(node_id, set()):
                new_out[variable] = {node_id}
            if dict(merged) != dict(incoming[node_id]) or dict(new_out) != dict(
                outgoing[node_id]
            ):
                incoming[node_id] = merged
                outgoing[node_id] = new_out
                queue.extend(cfg.successors.get(node_id, set()))

        result: list[FlowEdge] = []
        seen: set[tuple[str, str, str]] = set()
        for target, variables in uses.items():
            for variable in variables:
                candidates = set(incoming[target].get(variable, set()))
                root = variable.split(".", 1)[0]
                candidates.update(incoming[target].get(root, set()))
                for source in candidates:
                    key = (source, target, variable)
                    if key in seen:
                        continue
                    seen.add(key)
                    result.append(
                        FlowEdge(
                            source=source,
                            target=target,
                            kind="DATA",
                            variable=variable,
                            certainty="MUST" if len(candidates) == 1 else "MAY",
                        )
                    )
        return result

    def _control_edges(
        self, statements: list[ast.stmt], ids: dict[ast.stmt, str]
    ) -> list[FlowEdge]:
        result: list[FlowEdge] = []
        for statement in statements:
            if not isinstance(
                statement, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Match)
            ):
                continue
            for body in self._child_bodies(statement):
                for child in self._statements(body):
                    result.append(
                        FlowEdge(
                            source=ids[statement],
                            target=ids[child],
                            kind="CONTROL",
                            certainty="MAY",
                            detail=f"controlled by line {statement.lineno}",
                        )
                    )
        return result

    def _memory_edges(self, nodes: list[FlowNode]) -> list[FlowEdge]:
        writes: dict[str, list[FlowNode]] = defaultdict(list)
        result: list[FlowEdge] = []
        for node in nodes:
            for definition in node.defs:
                if "." in definition:
                    writes[definition.split(".", 1)[0]].append(node)
            for use in node.uses:
                root = use.split(".", 1)[0]
                for writer in writes.get(root, []):
                    if writer.node_id == node.node_id or use in writer.defs:
                        continue
                    result.append(
                        FlowEdge(
                            source=writer.node_id,
                            target=node.node_id,
                            kind="MEMORY_MAY",
                            variable=use,
                            certainty="MAY",
                            detail="shared object root may alias",
                        )
                    )
        return result

    def _probe_line(
        self,
        node_id: str,
        definitions: set[str],
        cfg: _Cfg,
        ids: dict[ast.stmt, str],
        statements: list[ast.stmt],
    ) -> int | None:
        line_by_id = {ids[node]: node.lineno for node in statements}
        current_line = line_by_id[node_id]
        if not definitions:
            return current_line
        successors = [
            line_by_id[target]
            for target in cfg.successors.get(node_id, set())
            if target in line_by_id and line_by_id[target] >= current_line
        ]
        return min(successors) if successors else current_line

    def _call_summaries(
        self,
        statements: list[ast.stmt],
        ids: dict[ast.stmt, str],
        source: str,
        definitions: dict[str, set[str]],
        import_aliases: dict[str, str],
    ) -> tuple[list[CallSite], list[DurableAccess]]:
        calls: list[CallSite] = []
        durable: list[DurableAccess] = []
        client_bindings = discover_client_bindings(
            statements,
            lambda target: _resolve_imported_target(target, import_aliases),
        )
        for statement in statements:
            node_id = ids[statement]
            statement_source = _source_segment(source, statement)
            for call in _calls_in_statement(statement):
                target = _resolve_imported_target(
                    _call_name(call), import_aliases
                )
                classification = classify_boundary_call(
                    call, target, client_bindings
                )
                boundary_kind: str = (
                    classification.kind
                    if classification is not None
                    else "local"
                )
                detail: str | None = (
                    classification.detail
                    if classification is not None
                    else None
                )
                if ".table" in statement_source and ".execute" in statement_source:
                    boundary_kind = "durable"
                    detail = detail or "supabase-query"
                contribution_role = _call_contribution_role(statement, call)
                if boundary_kind == "durable":
                    contribution_role = "HISTORICAL_STATE_PRODUCER"
                keyword_paths = tuple(
                    (
                        keyword.arg or "**",
                        tuple(sorted(_uses(keyword.value))),
                    )
                    for keyword in call.keywords
                )
                calls.append(
                    CallSite(
                        node_id=node_id,
                        target=target,
                        argument_paths=tuple(
                            tuple(sorted(_uses(argument))) for argument in call.args
                        ),
                        keyword_paths=keyword_paths,
                        result_paths=tuple(sorted(definitions[node_id])),
                        contribution_role=contribution_role,
                        boundary_kind=boundary_kind,  # type: ignore[arg-type]
                        boundary_detail=detail,
                    )
                )
            access = self._durable_access(statement, node_id)
            if access:
                durable.append(access)
        return calls, durable

    def _durable_access(
        self, statement: ast.stmt, node_id: str
    ) -> DurableAccess | None:
        calls = list(_calls_in_statement(statement))
        table: str | None = None
        fields: set[str] = set()
        keys: set[str] = set()
        operation: str = "unknown"
        for call in calls:
            target = _call_name(call)
            method = target.rsplit(".", 1)[-1]
            if method == "table" and call.args:
                table = _literal_string(call.args[0])
            elif method == "select":
                operation = "read"
                if call.args:
                    selected = _literal_string(call.args[0])
                    if selected:
                        fields.update(part.strip() for part in selected.split(","))
            elif method in {"update", "upsert", "insert"}:
                operation = "write"
                if call.args:
                    fields.update(_dict_keys(call.args[0]))
            elif method == "eq" and call.args:
                key = _literal_string(call.args[0])
                if key:
                    keys.add(key)
        if table is None:
            return None
        return DurableAccess(
            node_id=node_id,
            operation=operation,  # type: ignore[arg-type]
            resource=table,
            fields=tuple(sorted(fields)),
            key_fields=tuple(sorted(keys)),
        )

    def _route_summaries(
        self,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        function_id: str,
        parents: dict[ast.AST, ast.AST],
    ) -> list[RouteSummary]:
        result: list[RouteSummary] = []
        fields = tuple(
            argument.arg
            for argument in list(function.args.args) + list(function.args.kwonlyargs)
        )
        for decorator in function.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            target = _attribute_path(decorator.func)
            if target is None:
                continue
            method = target.rsplit(".", 1)[-1].upper()
            if method in {"ROUTE", "API_ROUTE"}:
                methods = next(
                    (
                        keyword.value
                        for keyword in decorator.keywords
                        if keyword.arg == "methods"
                    ),
                    None,
                )
                if isinstance(methods, (ast.List, ast.Tuple, ast.Set)):
                    route_path = (
                        _literal_string(decorator.args[0])
                        if decorator.args
                        else None
                    )
                    if route_path:
                        for item in methods.elts:
                            route_method = _literal_string(item)
                            if route_method:
                                result.append(
                                    RouteSummary(
                                        method=route_method.upper(),
                                        path=route_path,
                                        function_id=function_id,
                                        parameter_fields=fields,
                                    )
                                )
                continue
            if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                continue
            path = _literal_string(decorator.args[0]) if decorator.args else None
            if path:
                result.append(
                    RouteSummary(
                        method=method,
                        path=path,
                        function_id=function_id,
                        parameter_fields=fields,
                    )
                )
        parent = parents.get(function)
        if isinstance(parent, ast.ClassDef) and any(
            (_attribute_path(base) or "").endswith("Servicer")
            for base in parent.bases
        ):
            result.append(
                RouteSummary(
                    method="RPC",
                    path=function.name,
                    function_id=function_id,
                    parameter_fields=fields,
                )
            )
        return result

    def _hammocks(
        self,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        function_id: str,
        file: str,
        source: str,
        ids: dict[ast.stmt, str],
        exit_id: str,
        coverage: set[str],
    ) -> list[Hammock]:
        function_nodes = tuple(ids[statement] for statement in self._statements(function.body))
        function_hammock_id = f"hmk_{_digest(file, function_id, function_nodes)}"
        function_source, function_truncated = _bounded_source(
            _source_segment(source, function)
        )
        result = [
            Hammock(
                hammock_id=function_hammock_id,
                function_id=function_id,
                kind="function",
                entry_node=self._first_node(function.body, ids) or exit_id,
                exit_nodes=(exit_id,),
                node_ids=function_nodes,
                start_line=function.lineno,
                end_line=getattr(function, "end_lineno", function.lineno),
                parent_id=None,
                source=function_source,
                coverage_notes=tuple(
                    sorted(
                        coverage
                        | (
                            {"hammock source truncated to 16000 characters"}
                            if function_truncated
                            else set()
                        )
                    )
                ),
            )
        ]
        for statement in self._statements(function.body):
            bodies = self._child_bodies(statement)
            if not bodies:
                continue
            for index, body in enumerate(bodies):
                node_ids = tuple(ids[item] for item in self._statements(body))
                if not node_ids:
                    continue
                start = body[0].lineno
                end = getattr(body[-1], "end_lineno", body[-1].lineno)
                kind = f"{type(statement).__name__.lower()}:{index}"
                body_source, body_truncated = _bounded_source(
                    "\n".join(source.splitlines()[start - 1 : end])
                )
                result.append(
                    Hammock(
                        hammock_id=f"hmk_{_digest(file, function_id, kind, node_ids)}",
                        function_id=function_id,
                        kind=kind,
                        entry_node=node_ids[0],
                        exit_nodes=(node_ids[-1],),
                        node_ids=node_ids,
                        start_line=start,
                        end_line=end,
                        parent_id=function_hammock_id,
                        source=body_source,
                        coverage_notes=(
                            ("hammock source truncated to 16000 characters",)
                            if body_truncated
                            else ()
                        ),
                    )
                )
        return result
