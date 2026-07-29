"""Read-only, single-traversal serialization for captured Python values."""

from __future__ import annotations

import inspect
import json
import math
import types
from dataclasses import dataclass
from typing import Any, Mapping, TypeAlias

try:
    from google.protobuf.message import Message as _ProtobufMessage
except ImportError:  # LiveProbe intentionally keeps protobuf optional.
    _ProtobufMessage = None

SanitizedNode: TypeAlias = dict[str, Any]

DEFAULT_REDACT_KEYS = (
    "password",
    "secret",
    "token",
    "authorization",
    "cookie",
    "key",
    "signature",
    "ssn",
    "creditcard",
)
_MISSING = object()


def _non_negative_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


@dataclass(frozen=True, slots=True)
class SerializerConfig:
    """Structural and redaction limits used during serialization."""

    max_depth: int = 3
    max_array: int = 3
    max_props: int = 50
    max_string: int = 1024
    max_stack_frames: int = 8
    redact_keys: tuple[str, ...] = DEFAULT_REDACT_KEYS
    redact_values: tuple[str, ...] = ()

    def redacts_key(self, key: str) -> bool:
        folded = key.casefold()
        return any(pattern.casefold() in folded for pattern in self.redact_keys)

    @classmethod
    def from_mapping(
        cls,
        config: Mapping[str, object] | None = None,
        *,
        redact_keys: tuple[str, ...] | list[str] | None = None,
        redact_values: tuple[str, ...] | list[str] | None = None,
    ) -> SerializerConfig:
        source = config or {}
        numeric = {
            "max_depth": source.get("maxDepth", source.get("max_depth", 3)),
            "max_array": source.get("maxArray", source.get("max_array", 3)),
            "max_props": source.get("maxProps", source.get("max_props", 50)),
            "max_string": source.get("maxString", source.get("max_string", 1024)),
            "max_stack_frames": source.get(
                "maxStackFrames", source.get("max_stack_frames", 8)
            ),
        }

        configured_keys = source.get("redactKeys", source.get("redact_keys", ()))
        configured_values = source.get(
            "redactValues", source.get("redact_values", ())
        )
        if not isinstance(configured_keys, (list, tuple)):
            raise ValueError("redactKeys must be an array of strings")
        if not isinstance(configured_values, (list, tuple)):
            raise ValueError("redactValues must be an array of strings")

        key_candidates = (*DEFAULT_REDACT_KEYS, *configured_keys, *(redact_keys or ()))
        keys: list[str] = []
        seen: set[str] = set()
        for key in key_candidates:
            if not isinstance(key, str) or not key:
                raise ValueError("redactKeys entries must be non-empty strings")
            folded = key.casefold()
            if folded not in seen:
                seen.add(folded)
                keys.append(key)

        value_candidates = (*configured_values, *(redact_values or ()))
        values: list[str] = []
        for value in value_candidates:
            if not isinstance(value, str):
                raise ValueError("redactValues entries must be strings")
            if value not in values:
                values.append(value)

        return cls(
            max_depth=_non_negative_int(numeric["max_depth"], "maxDepth"),
            max_array=_non_negative_int(numeric["max_array"], "maxArray"),
            max_props=_non_negative_int(numeric["max_props"], "maxProps"),
            max_string=_non_negative_int(numeric["max_string"], "maxString"),
            max_stack_frames=_non_negative_int(
                numeric["max_stack_frames"], "maxStackFrames"
            ),
            redact_keys=tuple(keys),
            redact_values=tuple(values),
        )


def _static_instance_dict(value: object) -> dict[object, object] | None:
    """Return an instance dictionary without invoking descriptors."""

    try:
        namespace = inspect.getattr_static(value, "__dict__", _MISSING)
    except (AttributeError, TypeError):
        return None
    if isinstance(namespace, dict):
        return namespace
    if type(namespace) is not types.GetSetDescriptorType:
        return None
    try:
        resolved = object.__getattribute__(value, "__dict__")
    except (AttributeError, TypeError):
        return None
    return resolved if isinstance(resolved, dict) else None


def serialize(
    raw: object,
    config: SerializerConfig | Mapping[str, object] | None = None,
    *,
    redact_keys: tuple[str, ...] | list[str] | None = None,
    redact_values: tuple[str, ...] | list[str] | None = None,
    root_key: str | None = None,
) -> SanitizedNode:
    """Serialize and redact ``raw`` in one traversal.

    Only builtin container storage and statically obtained instance dictionaries
    are traversed. Properties, descriptors, arbitrary iterators, and conversion
    methods are never invoked.
    """

    if isinstance(config, SerializerConfig):
        if redact_keys or redact_values:
            raise ValueError("runtime redaction cannot extend a prepared config")
        prepared = config
    else:
        prepared = SerializerConfig.from_mapping(
            config, redact_keys=redact_keys, redact_values=redact_values
        )

    redacted_values = frozenset(prepared.redact_values)
    redact_patterns = tuple(pattern.casefold() for pattern in prepared.redact_keys)
    active_ancestors: set[int] = set()

    def key_is_redacted(key: str) -> bool:
        folded = key.casefold()
        return any(pattern in folded for pattern in redact_patterns)

    def visit_protobuf_repeated(
        value: object,
        field: object,
        depth: int,
    ) -> SanitizedNode:
        try:
            message_type = getattr(field, "message_type", None)
            is_map = bool(
                message_type is not None
                and message_type.GetOptions().map_entry
            )
            length = len(value)  # type: ignore[arg-type]
        except (AttributeError, TypeError):
            return {"t": "truncated", "v": "unsupported"}
        if is_map:
            try:
                keys = list(value.keys())  # type: ignore[union-attr]
            except (AttributeError, TypeError):
                return {"t": "truncated", "v": "unsupported"}
            retained_keys = keys[: prepared.max_props]
            children_by_key: dict[str, SanitizedNode] = {}
            omitted = len(keys) > len(retained_keys)
            for raw_key in retained_keys:
                key = str(raw_key)
                if key_is_redacted(key):
                    children_by_key[key] = {"t": "redacted"}
                    continue
                try:
                    child = value[raw_key]  # type: ignore[index]
                except (KeyError, TypeError):
                    omitted = True
                    continue
                children_by_key[key] = visit(child, depth + 1)
            node: SanitizedNode = {"t": "obj", "c": children_by_key}
            if omitted:
                node["m"] = {"t": "truncated", "v": "props"}
            return node

        retained = min(length, prepared.max_array)
        children = []
        for index in range(retained):
            try:
                child = value[index]  # type: ignore[index]
            except (IndexError, TypeError):
                return {"t": "truncated", "v": "unsupported"}
            children.append(visit(child, depth + 1))
        node = {"t": "arr", "c": children}
        if retained < length:
            node["m"] = {"t": "truncated", "v": "array"}
        return node

    def visit_protobuf(value: object, depth: int) -> SanitizedNode:
        identity = id(value)
        if identity in active_ancestors:
            return {"t": "truncated", "v": "circular"}
        active_ancestors.add(identity)
        try:
            try:
                fields = list(value.ListFields())  # type: ignore[union-attr]
            except (AttributeError, TypeError, ValueError):
                return {"t": "truncated", "v": "unsupported"}
            retained_fields = fields[: prepared.max_props]
            children_by_key: dict[str, SanitizedNode] = {}
            omitted = len(fields) > len(retained_fields)
            for field, child in retained_fields:
                name = getattr(field, "name", None)
                if not isinstance(name, str) or not name:
                    omitted = True
                    continue
                if key_is_redacted(name):
                    children_by_key[name] = {"t": "redacted"}
                    continue
                if bool(getattr(field, "is_repeated", False)):
                    children_by_key[name] = visit_protobuf_repeated(
                        child,
                        field,
                        depth + 1,
                    )
                else:
                    children_by_key[name] = visit(child, depth + 1)
            node: SanitizedNode = {"t": "obj", "c": children_by_key}
            if omitted:
                node["m"] = {"t": "truncated", "v": "props"}
            return node
        finally:
            active_ancestors.remove(identity)

    def visit(value: object, depth: int) -> SanitizedNode:
        if type(value) is str and value in redacted_values:
            return {"t": "redacted"}
        if depth > prepared.max_depth:
            return {"t": "truncated", "v": "depth"}
        if value is None:
            return {"t": "null", "v": None}
        if type(value) is bool:
            return {"t": "bool", "v": value}
        if type(value) is int:
            return {"t": "num", "v": value}
        if type(value) is float:
            if math.isfinite(value):
                return {"t": "num", "v": value}
            return {"t": "truncated", "v": "unsupported"}
        if type(value) is str:
            if len(value) > prepared.max_string:
                return {"t": "truncated", "v": "string"}
            return {"t": "str", "v": value}
        if callable(value):
            return {"t": "fn"}
        if (
            _ProtobufMessage is not None
            and isinstance(value, _ProtobufMessage)
        ):
            return visit_protobuf(value, depth)

        is_list = isinstance(value, list)
        is_tuple = isinstance(value, tuple)
        namespace = None if is_list or is_tuple else _static_instance_dict(value)
        is_dict = isinstance(value, dict)
        if not (is_list or is_tuple or is_dict or namespace is not None):
            return {"t": "truncated", "v": "unsupported"}

        identity = id(value)
        if identity in active_ancestors:
            return {"t": "truncated", "v": "circular"}
        active_ancestors.add(identity)
        try:
            if is_list or is_tuple:
                length = (
                    list.__len__(value)
                    if is_list
                    else tuple.__len__(value)
                )
                retained = min(length, prepared.max_array)
                children = []
                for index in range(retained):
                    item = (
                        list.__getitem__(value, index)
                        if is_list
                        else tuple.__getitem__(value, index)
                    )
                    children.append(visit(item, depth + 1))
                node: SanitizedNode = {"t": "arr", "c": children}
                if retained < length:
                    node["m"] = {"t": "truncated", "v": "array"}
                return node

            source = value if is_dict else namespace
            assert isinstance(source, dict)
            keys = list(dict.keys(source))
            retained_keys = keys[: prepared.max_props]
            children_by_key: dict[str, SanitizedNode] = {}
            omitted = len(keys) > len(retained_keys)
            for key in retained_keys:
                if not isinstance(key, str):
                    omitted = True
                    continue
                if key_is_redacted(key):
                    children_by_key[key] = {"t": "redacted"}
                    continue
                child = dict.__getitem__(source, key)
                children_by_key[key] = visit(child, depth + 1)
            node = {"t": "obj", "c": children_by_key}
            if omitted:
                node["m"] = {"t": "truncated", "v": "props"}
            return node
        finally:
            active_ancestors.remove(identity)

    if root_key is not None and key_is_redacted(root_key):
        return {"t": "redacted"}
    return visit(raw, 0)


def materialize_fixture(value: object) -> object:
    """Materialize the shared JSON fixture tags, including circular references."""

    registered: dict[str, object] = {}

    def materialize(current: object) -> object:
        if isinstance(current, list):
            return [materialize(item) for item in current]
        if not isinstance(current, dict):
            return current

        tag = dict.get(current, "$fixture")
        if tag == "function":
            def fixture_function() -> None:
                return None

            return fixture_function
        if tag == "ref":
            identifier = dict.get(current, "id")
            if not isinstance(identifier, str) or identifier not in registered:
                raise ValueError("fixture ref must name a previously registered container")
            return registered[identifier]
        if tag in {"object", "array"}:
            identifier = dict.get(current, "id")
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("fixture containers require a non-empty id")
            if identifier in registered:
                raise ValueError(f"duplicate fixture id: {identifier}")
            encoded = dict.get(current, "value")
            if tag == "object":
                if not isinstance(encoded, dict):
                    raise ValueError("object fixture value must be an object")
                target_object: dict[str, object] = {}
                registered[identifier] = target_object
                for key in dict.keys(encoded):
                    if not isinstance(key, str):
                        raise ValueError("fixture object keys must be strings")
                    target_object[key] = materialize(dict.__getitem__(encoded, key))
                return target_object
            if not isinstance(encoded, list):
                raise ValueError("array fixture value must be an array")
            target_array: list[object] = []
            registered[identifier] = target_array
            for item in encoded:
                target_array.append(materialize(item))
            return target_array

        result: dict[str, object] = {}
        for key in dict.keys(current):
            if not isinstance(key, str):
                raise ValueError("fixture object keys must be strings")
            result[key] = materialize(dict.__getitem__(current, key))
        return result

    return materialize(value)


def render_node(node: SanitizedNode) -> str:
    """Render a sanitized node without consulting the original captured value."""

    kind = node["t"]
    if kind == "str":
        return node["v"]
    if kind == "num":
        return str(node["v"])
    if kind == "bool":
        return "true" if node["v"] else "false"
    if kind == "null":
        return "null"
    if kind == "redacted":
        return "[REDACTED]"
    if kind == "fn":
        return "[function]"
    if kind == "truncated":
        return f"[truncated:{node['v']}]"
    if kind == "arr":
        rendered = [render_node(child) for child in node["c"]]
        if "m" in node:
            rendered.append(render_node(node["m"]))
        return json.dumps(rendered, separators=(",", ":"))
    rendered_object = {
        key: render_node(child) for key, child in node["c"].items()
    }
    if "m" in node:
        rendered_object["..."] = render_node(node["m"])
    return json.dumps(rendered_object, separators=(",", ":"), sort_keys=True)
