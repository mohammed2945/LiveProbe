"""Conservative external-boundary classification for Python calls.

The classifier recognizes only calls with library or constructor provenance.
Method names such as ``get`` and ``send`` are intentionally insufficient:
``dict.get`` and application methods must remain local. Unknown client-like
receivers are surfaced as unknown boundaries instead of being silently treated
as proven local calls.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Callable, Iterable, Literal, Mapping

BoundaryKind = Literal["http", "service", "durable", "unknown"]
ClientKind = Literal["http", "rpc", "socket", "durable"]

_HTTP_VERBS = frozenset({"get", "post", "put", "patch", "delete", "head", "options"})
_HTTP_FUNCTIONS = _HTTP_VERBS | {"request", "urlopen", "getresponse"}
_HTTP_MODULE_PREFIXES = (
    "requests",
    "httpx",
    "aiohttp",
    "urllib.request",
    "urllib3",
)
_HTTP_CONSTRUCTORS = (
    "requests.Session",
    "httpx.Client",
    "httpx.AsyncClient",
    "aiohttp.ClientSession",
    "urllib3.PoolManager",
    "http.client.HTTPConnection",
    "http.client.HTTPSConnection",
)
_SOCKET_CONSTRUCTORS = (
    "socket.socket",
    "socket.create_connection",
)
_SOCKET_OPERATIONS = frozenset(
    {
        "accept",
        "connect",
        "connect_ex",
        "recv",
        "recvfrom",
        "recv_into",
        "send",
        "sendall",
        "sendto",
    }
)
_RPC_CHANNEL_OPERATIONS = frozenset(
    {
        "stream_stream",
        "stream_unary",
        "unary_stream",
        "unary_unary",
    }
)
_DURABLE_CONSTRUCTORS = (
    "redis.Redis",
    "redis.StrictRedis",
    "pymongo.MongoClient",
    "neo4j.GraphDatabase.driver",
    "sqlalchemy.create_engine",
    "psycopg.connect",
    "psycopg2.connect",
    "asyncpg.connect",
)
_CLIENT_LIKE_SUFFIXES = (
    "_client",
    "_connection",
    "_conn",
    "_consumer",
    "_producer",
    "_session",
    "_stub",
)


@dataclass(frozen=True, slots=True)
class BoundaryClassification:
    kind: BoundaryKind
    detail: str
    detector: str


def _attribute_path(node: ast.AST) -> str | None:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
        return ".".join(reversed(parts))
    return None


def _call_name(call: ast.Call) -> str:
    return _attribute_path(call.func) or "<dynamic>"


def _target_names(target: ast.AST) -> tuple[str, ...]:
    if isinstance(target, (ast.Tuple, ast.List)):
        return tuple(
            name
            for item in target.elts
            for name in _target_names(item)
        )
    path = _attribute_path(target)
    return (path,) if path is not None else ()


def _constructor_kind(target: str) -> ClientKind | None:
    if target in _HTTP_CONSTRUCTORS:
        return "http"
    if target in _SOCKET_CONSTRUCTORS:
        return "socket"
    if target in _DURABLE_CONSTRUCTORS:
        return "durable"
    if target.endswith("Stub"):
        return "rpc"
    return None


def discover_client_bindings(
    statements: Iterable[ast.stmt],
    resolve_target: Callable[[str], str],
) -> dict[str, ClientKind]:
    """Track direct client constructors assigned to names or with-targets."""

    result: dict[str, ClientKind] = {}

    def bind(target: ast.AST, value: ast.AST | None) -> None:
        if not isinstance(value, ast.Call):
            return
        constructor = resolve_target(_call_name(value))
        kind = _constructor_kind(constructor)
        if kind is None:
            return
        for name in _target_names(target):
            result[name] = kind

    for statement in statements:
        if isinstance(statement, ast.Assign):
            for target in statement.targets:
                bind(target, statement.value)
        elif isinstance(statement, ast.AnnAssign):
            bind(statement.target, statement.value)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            for item in statement.items:
                if item.optional_vars is not None:
                    bind(item.optional_vars, item.context_expr)
    return result


def _render(node: ast.AST | None) -> str:
    if node is None:
        return "<dynamic>"
    try:
        return ast.unparse(node)
    except (AttributeError, ValueError):
        return "<dynamic>"


def _http_detail(call: ast.Call, method: str) -> str:
    if method == "request":
        request_method = _render(call.args[0] if call.args else None).strip("'\"")
        url = _render(call.args[1] if len(call.args) > 1 else None)
        return f"http:{request_method.upper()}:{url}"
    url = _render(call.args[0] if call.args else None)
    return f"http:{method.upper()}:{url}"


def classify_boundary_call(
    call: ast.Call,
    resolved_target: str,
    bindings: Mapping[str, ClientKind],
) -> BoundaryClassification | None:
    """Classify a call only when receiver provenance supports the boundary."""

    receiver, separator, method = resolved_target.rpartition(".")
    if not separator:
        receiver = ""
        method = resolved_target
    method_lower = method.lower()
    root = resolved_target.split(".", 1)[0]
    bound_kind = bindings.get(root) or bindings.get(receiver)

    if (
        method_lower in _HTTP_FUNCTIONS
        and (
            resolved_target.startswith(_HTTP_MODULE_PREFIXES)
            or bound_kind == "http"
        )
    ):
        return BoundaryClassification(
            kind="http",
            detail=_http_detail(call, method_lower),
            detector="known-http-client",
        )

    if (
        root.endswith("_stub")
        or bound_kind == "rpc"
        or (
            resolved_target.startswith("grpc.")
            and method_lower in _RPC_CHANNEL_OPERATIONS
        )
    ):
        return BoundaryClassification(
            kind="service",
            detail=f"rpc:{method}",
            detector="grpc-stub-or-channel",
        )

    if bound_kind == "socket" and method_lower in _SOCKET_OPERATIONS:
        return BoundaryClassification(
            kind="service",
            detail=f"socket:{method_lower}",
            detector="socket-client",
        )

    if bound_kind == "durable":
        return BoundaryClassification(
            kind="durable",
            detail=f"client:{receiver or root}:{method}",
            detector="known-durable-client",
        )

    if resolved_target == "<dynamic>" or (
        method_lower not in {"get", "set", "add", "remove", "update"}
        and root.lower().endswith(_CLIENT_LIKE_SUFFIXES)
    ):
        return BoundaryClassification(
            kind="unknown",
            detail=f"unresolved-client:{resolved_target}",
            detector="client-like-unresolved",
        )
    return None


__all__ = [
    "BoundaryClassification",
    "BoundaryKind",
    "classify_boundary_call",
    "discover_client_bindings",
]
