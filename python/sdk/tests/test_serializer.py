from __future__ import annotations

import json
from pathlib import Path

import pytest

import liveprobe.serializer as serializer_module
from liveprobe.serializer import (
    SerializerConfig,
    materialize_fixture,
    serialize,
)

FIXTURE_DIR = (
    Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "serializer"
)
FIXTURES = sorted(FIXTURE_DIR.glob("*.json"))


@pytest.mark.parametrize("fixture_path", FIXTURES, ids=lambda path: path.stem)
def test_shared_serializer_fixture(fixture_path: Path) -> None:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    raw = materialize_fixture(fixture["input"])

    actual = serialize(raw, fixture["config"])

    assert actual == fixture["expected"]
    json.dumps(actual, allow_nan=False)


def test_all_six_required_fixtures_are_exercised() -> None:
    assert {path.name for path in FIXTURES} >= {
        "nested-secrets.json",
        "deep-object.json",
        "long-array.json",
        "circular.json",
        "redact-values.json",
        "mixed-kitchen-sink.json",
    }


def test_properties_are_not_invoked() -> None:
    class Dangerous:
        def __init__(self) -> None:
            self.safe = "visible"
            self.password = "hidden"

        @property
        def explosive(self) -> str:
            raise AssertionError("property was invoked")

    assert serialize(Dangerous()) == {
        "t": "obj",
        "c": {
            "safe": {"t": "str", "v": "visible"},
            "password": {"t": "redacted"},
        },
    }


def test_redacted_dict_key_is_checked_before_value_read() -> None:
    class DangerousDict(dict[str, object]):
        def __getitem__(self, key: str) -> object:
            raise AssertionError("overridden item lookup was invoked")

    raw = DangerousDict(password="must never be read", safe=7)

    assert serialize(raw)["c"] == {
        "password": {"t": "redacted"},
        "safe": {"t": "num", "v": 7},
    }


def test_protobuf_adapter_is_bounded_redacted_and_not_duck_typed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Options:
        map_entry = False

    class MessageType:
        def GetOptions(self) -> Options:
            return Options()

    class Field:
        def __init__(self, name: str, *, repeated: bool = False) -> None:
            self.name = name
            self.is_repeated = repeated
            self.message_type = MessageType() if repeated else None

    class TrustedMessage:
        def __init__(self, fields: list[tuple[Field, object]]) -> None:
            self.fields = fields

        def ListFields(self) -> list[tuple[Field, object]]:
            return self.fields

    class Lookalike:
        def ListFields(self) -> None:
            raise AssertionError("duck-typed protobuf method was invoked")

    monkeypatch.setattr(
        serializer_module,
        "_ProtobufMessage",
        TrustedMessage,
    )
    products = [
        TrustedMessage(
            [
                (Field("id"), f"product-{index}"),
                (Field("api_token"), "must-not-leak"),
            ]
        )
        for index in range(4)
    ]
    response = TrustedMessage(
        [(Field("products", repeated=True), products)]
    )

    assert serialize(response, {"maxArray": 2}) == {
        "t": "obj",
        "c": {
            "products": {
                "t": "arr",
                "c": [
                    {
                        "t": "obj",
                        "c": {
                            "id": {"t": "str", "v": "product-0"},
                            "api_token": {"t": "redacted"},
                        },
                    },
                    {
                        "t": "obj",
                        "c": {
                            "id": {"t": "str", "v": "product-1"},
                            "api_token": {"t": "redacted"},
                        },
                    },
                ],
                "m": {"t": "truncated", "v": "array"},
            }
        },
    }
    assert serialize(Lookalike()) == {"t": "obj", "c": {}}


def test_fixture_encoding_materializes_identity_cycle() -> None:
    raw = materialize_fixture(
        {
            "$fixture": "object",
            "id": "root",
            "value": {"self": {"$fixture": "ref", "id": "root"}},
        }
    )

    assert isinstance(raw, dict)
    assert dict.__getitem__(raw, "self") is raw
    assert serialize(raw, {"maxDepth": 5}) == {
        "t": "obj",
        "c": {"self": {"t": "truncated", "v": "circular"}},
    }


@pytest.mark.parametrize(
    "config",
    [
        {"maxDepth": -1},
        {"maxArray": True},
        {"maxProps": 1.5},
        {"redactKeys": [""]},
        {"redactValues": [1]},
    ],
)
def test_invalid_serializer_config_is_rejected(config: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        SerializerConfig.from_mapping(config)
