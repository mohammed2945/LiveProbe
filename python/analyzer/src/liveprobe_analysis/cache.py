"""Revision-aware SQLite cache for analysis fragments and investigation plans."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3
import subprocess
import time
import tokenize
from pathlib import Path
from typing import Iterable

from .frontend import PythonFrontend
from .model import FunctionFragment, FunctionSummary
from .summary import build_function_summary

SCHEMA_VERSION = 17
EXCLUDED_PARTS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
}


def _repo_key(root: Path) -> str:
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:20]


def default_cache_path(root: Path) -> Path:
    configured = os.environ.get("LIVEPROBE_ANALYSIS_CACHE")
    if configured:
        base = Path(configured).expanduser()
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    elif sys_platform() == "darwin":
        base = Path.home() / "Library/Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "liveprobe-analysis" / f"{_repo_key(root)}.sqlite3"


def sys_platform() -> str:
    import sys

    return sys.platform


class AnalysisCache:
    def __init__(self, root: Path, database: Path | None = None) -> None:
        self.root = root.resolve()
        self.database = database or default_cache_path(self.root)
        fallback = self.root / ".liveprobe" / "analysis.sqlite3"
        try:
            self.database.parent.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(self.database)
        except (OSError, sqlite3.OperationalError):
            self.database = fallback
            self.database.parent.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(self.database)
        self.connection.row_factory = sqlite3.Row
        self._migrate()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> AnalysisCache:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _migrate(self) -> None:
        self.connection.executescript(
            """
            create table if not exists metadata (
              key text primary key,
              value text not null
            );
            """
        )
        version = self.connection.execute(
            "select value from metadata where key = 'schema_version'"
        ).fetchone()
        if version is not None and int(version["value"]) != SCHEMA_VERSION:
            self.connection.executescript(
                """
                drop table if exists file_fragments;
                drop table if exists function_fragments;
                drop table if exists revisions;
                drop table if exists revision_functions;
                drop table if exists plans;
                drop table if exists investigations;
                """
            )
        self.connection.executescript(
            """
            create table if not exists file_fragments (
              path text not null,
              content_hash text not null,
              payload text not null,
              analyzed_at real not null,
              primary key (path, content_hash)
            );
            create table if not exists revisions (
              commit_sha text not null,
              path text not null,
              content_hash text not null,
              primary key (commit_sha, path)
            );
            create table if not exists function_fragments (
              path text not null,
              content_hash text not null,
              function_id text not null,
              qualified_name text not null,
              start_line integer not null,
              end_line integer not null,
              summary_payload text not null,
              fragment_payload text not null,
              primary key (path, content_hash, function_id)
            );
            create index if not exists function_fragments_location
              on function_fragments(path, content_hash, start_line, end_line);
            create table if not exists revision_functions (
              commit_sha text not null,
              function_id text not null,
              path text not null,
              content_hash text not null,
              primary key (commit_sha, function_id)
            );
            create index if not exists revision_functions_path
              on revision_functions(commit_sha, path);
            create table if not exists plans (
              plan_id text primary key,
              payload text not null,
              updated_at real not null
            );
            create table if not exists investigations (
              investigation_id text primary key,
              payload text not null,
              updated_at real not null
            );
            """
        )
        self.connection.execute(
            "insert or replace into metadata(key, value) values('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        self.connection.commit()

    def validate_commit(self, commit: str) -> str:
        if not 7 <= len(commit) <= 64 or any(
            character not in "0123456789abcdefABCDEF" for character in commit
        ):
            raise ValueError("commit must be a 7-64 character hexadecimal Git SHA")
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", f"{commit}^{{commit}}"],
                cwd=self.root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise ValueError(
                f"commit {commit.lower()} is not available in {self.root}"
            ) from error
        return result

    def prepare(self, commit: str) -> dict[str, int | float | str]:
        started = time.perf_counter()
        full_commit = self.validate_commit(commit)
        frontend = PythonFrontend()
        indexed = 0
        reused = 0
        fragments = 0
        paths = list(self._python_files(full_commit))
        cached_payloads: dict[tuple[str, str], str] = {}
        missing_paths: list[str] = []
        for relative, digest in paths:
            cached = self.connection.execute(
                """
                select payload from file_fragments
                where path = ? and content_hash = ?
                """,
                (relative, digest),
            ).fetchone()
            if cached is None:
                missing_paths.append(relative)
            else:
                cached_payloads[(relative, digest)] = cached["payload"]
        missing_blobs = iter(self._python_blobs(full_commit, missing_paths))
        try:
            with self.connection:
                self.connection.execute(
                    "delete from revisions where commit_sha = ?", (full_commit,)
                )
                self.connection.execute(
                    "delete from revision_functions where commit_sha = ?",
                    (full_commit,),
                )
                for relative, digest in paths:
                    payload = cached_payloads.get((relative, digest))
                    analyzed_fragments: list[FunctionFragment] | None = None
                    if payload is not None:
                        reused += 1
                    else:
                        blob_path, content = next(missing_blobs)
                        if blob_path != relative:
                            raise RuntimeError("Git blob stream order changed")
                        analyzed_fragments = frontend.analyze_source(
                            self._decode_python(content), relative
                        )
                        values = [
                            fragment.to_dict()
                            for fragment in analyzed_fragments
                        ]
                        payload = json.dumps(values, separators=(",", ":"))
                        self.connection.execute(
                            """
                            insert into file_fragments(
                              path, content_hash, payload, analyzed_at
                            ) values(?, ?, ?, ?)
                            on conflict(path, content_hash) do update set
                              payload=excluded.payload,
                              analyzed_at=excluded.analyzed_at
                            """,
                            (relative, digest, payload, time.time()),
                        )
                        indexed += 1
                    function_rows = self.connection.execute(
                        """
                        select function_id from function_fragments
                        where path = ? and content_hash = ?
                        order by function_id
                        """,
                        (relative, digest),
                    ).fetchall()
                    if not function_rows:
                        if analyzed_fragments is None:
                            analyzed_fragments = [
                                FunctionFragment.from_dict(value)
                                for value in json.loads(payload)
                            ]
                        for fragment in analyzed_fragments:
                            summary = build_function_summary(fragment)
                            self.connection.execute(
                                """
                                insert into function_fragments(
                                  path, content_hash, function_id,
                                  qualified_name, start_line, end_line,
                                  summary_payload, fragment_payload
                                ) values(?, ?, ?, ?, ?, ?, ?, ?)
                                on conflict(path, content_hash, function_id)
                                do update set
                                  qualified_name=excluded.qualified_name,
                                  start_line=excluded.start_line,
                                  end_line=excluded.end_line,
                                  summary_payload=excluded.summary_payload,
                                  fragment_payload=excluded.fragment_payload
                                """,
                                (
                                    relative,
                                    digest,
                                    fragment.function_id,
                                    fragment.qualified_name,
                                    fragment.start_line,
                                    fragment.end_line,
                                    json.dumps(
                                        summary.to_dict(),
                                        separators=(",", ":"),
                                    ),
                                    json.dumps(
                                        fragment.to_dict(),
                                        separators=(",", ":"),
                                    ),
                                ),
                            )
                        function_ids = [
                            fragment.function_id
                            for fragment in analyzed_fragments
                        ]
                    else:
                        function_ids = [
                            str(row["function_id"]) for row in function_rows
                        ]
                    fragments += len(function_ids)
                    self.connection.execute(
                        """
                        insert into revisions(commit_sha, path, content_hash)
                        values(?, ?, ?)
                        """,
                        (full_commit, relative, digest),
                    )
                    for function_id in function_ids:
                        self.connection.execute(
                            """
                            insert into revision_functions(
                              commit_sha, function_id, path, content_hash
                            ) values(?, ?, ?, ?)
                            """,
                            (full_commit, function_id, relative, digest),
                        )
        finally:
            close = getattr(missing_blobs, "close", None)
            if callable(close):
                close()
        elapsed = time.perf_counter() - started
        return {
            "commit": full_commit,
            "files": len(paths),
            "indexedFiles": indexed,
            "reusedFiles": reused,
            "functions": fragments,
            "cachePath": str(self.database),
            "cacheBytes": self.database.stat().st_size,
            "elapsedMs": round(elapsed * 1000, 3),
        }

    def load_fragments(self, commit: str) -> list[FunctionFragment]:
        full_commit = self.validate_commit(commit)
        rows = self.connection.execute(
            """
            select f.payload
            from revisions r
            join file_fragments f
              on f.path = r.path and f.content_hash = r.content_hash
            where r.commit_sha = ?
            order by r.path
            """,
            (full_commit,),
        ).fetchall()
        if not rows:
            self.prepare(full_commit)
            return self.load_fragments(full_commit)
        result: list[FunctionFragment] = []
        for row in rows:
            result.extend(
                FunctionFragment.from_dict(value)
                for value in json.loads(row["payload"])
            )
        return result

    def load_summaries(
        self,
        commit: str,
        source_roots: tuple[str, ...] = (),
    ) -> list[FunctionSummary]:
        full_commit = self.validate_commit(commit)
        rows = self.connection.execute(
            """
            select f.summary_payload
            from revision_functions r
            join function_fragments f
              on f.path = r.path
             and f.content_hash = r.content_hash
             and f.function_id = r.function_id
            where r.commit_sha = ?
            order by r.path, f.start_line, f.function_id
            """,
            (full_commit,),
        ).fetchall()
        if not rows:
            self.prepare(full_commit)
            return self.load_summaries(full_commit, source_roots)
        values = [
            FunctionSummary.from_dict(json.loads(row["summary_payload"]))
            for row in rows
        ]
        if not source_roots:
            return values
        normalized = tuple(root.rstrip("/") for root in source_roots)
        return [
            summary
            for summary in values
            if any(
                summary.file == root
                or summary.file.startswith(root + "/")
                for root in normalized
            )
        ]

    def load_fragment(self, commit: str, function_id: str) -> FunctionFragment:
        full_commit = self.validate_commit(commit)
        row = self.connection.execute(
            """
            select f.fragment_payload
            from revision_functions r
            join function_fragments f
              on f.path = r.path
             and f.content_hash = r.content_hash
             and f.function_id = r.function_id
            where r.commit_sha = ? and r.function_id = ?
            """,
            (full_commit, function_id),
        ).fetchone()
        if row is None:
            if not self.connection.execute(
                "select 1 from revision_functions where commit_sha = ? limit 1",
                (full_commit,),
            ).fetchone():
                self.prepare(full_commit)
                return self.load_fragment(full_commit, function_id)
            raise KeyError(f"unknown function {function_id} at {full_commit}")
        return FunctionFragment.from_dict(json.loads(row["fragment_payload"]))

    def find_summary_at(
        self, commit: str, file: str, line: int
    ) -> FunctionSummary:
        full_commit = self.validate_commit(commit)
        rows = self.connection.execute(
            """
            select f.summary_payload, f.start_line, f.end_line
            from revision_functions r
            join function_fragments f
              on f.path = r.path
             and f.content_hash = r.content_hash
             and f.function_id = r.function_id
            where r.commit_sha = ?
              and r.path = ?
              and f.start_line <= ?
              and f.end_line >= ?
            order by (f.end_line - f.start_line), f.start_line desc
            """,
            (full_commit, file, line, line),
        ).fetchall()
        if not rows:
            if not self.connection.execute(
                "select 1 from revision_functions where commit_sha = ? limit 1",
                (full_commit,),
            ).fetchone():
                self.prepare(full_commit)
                return self.find_summary_at(full_commit, file, line)
            raise ValueError(f"no analyzed Python function at {file}:{line}")
        return FunctionSummary.from_dict(json.loads(rows[0]["summary_payload"]))

    def save_plan(self, plan_id: str, payload: dict[str, object]) -> None:
        with self.connection:
            self.connection.execute(
                """
                insert into plans(plan_id, payload, updated_at) values(?, ?, ?)
                on conflict(plan_id) do update set
                  payload=excluded.payload,
                  updated_at=excluded.updated_at
                """,
                (plan_id, json.dumps(payload, separators=(",", ":")), time.time()),
            )

    def load_plan(self, plan_id: str) -> dict[str, object]:
        row = self.connection.execute(
            "select payload from plans where plan_id = ?", (plan_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"unknown analysis plan {plan_id}")
        return json.loads(row["payload"])

    def save_investigation(
        self, investigation_id: str, payload: dict[str, object]
    ) -> None:
        with self.connection:
            self.connection.execute(
                """
                insert into investigations(
                  investigation_id, payload, updated_at
                ) values(?, ?, ?)
                on conflict(investigation_id) do update set
                  payload=excluded.payload,
                  updated_at=excluded.updated_at
                """,
                (
                    investigation_id,
                    json.dumps(payload, separators=(",", ":")),
                    time.time(),
                ),
            )

    def load_investigation(self, investigation_id: str) -> dict[str, object]:
        row = self.connection.execute(
            """
            select payload from investigations
            where investigation_id = ?
            """,
            (investigation_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"unknown investigation {investigation_id}")
        return json.loads(row["payload"])

    def _python_files(self, commit: str) -> Iterable[tuple[str, str]]:
        output = subprocess.run(
            ["git", "ls-tree", "-r", "-z", commit],
            cwd=self.root,
            check=True,
            capture_output=True,
        ).stdout
        entries: list[tuple[str, str]] = []
        for raw in (part for part in output.split(b"\0") if part):
            metadata, separator, raw_path = raw.partition(b"\t")
            parts = metadata.split()
            if separator != b"\t" or len(parts) != 3 or parts[1] != b"blob":
                continue
            relative = raw_path.decode("utf-8", errors="surrogateescape")
            path = Path(relative)
            if path.suffix != ".py":
                continue
            if any(part in EXCLUDED_PARTS for part in path.parts):
                continue
            entries.append((relative, parts[2].decode("ascii")))
        yield from sorted(entries)

    def _python_blobs(
        self, commit: str, paths: list[str]
    ) -> Iterable[tuple[str, bytes]]:
        process = subprocess.Popen(
            ["git", "cat-file", "--batch"],
            cwd=self.root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        try:
            for path in paths:
                if "\n" in path or "\r" in path:
                    raise ValueError(
                        "Python paths containing newlines are unsupported"
                    )
                process.stdin.write(f"{commit}:{path}\n".encode())
                process.stdin.flush()
                header = process.stdout.readline()
                parts = header.rstrip(b"\n").split()
                if len(parts) != 3 or parts[1] != b"blob":
                    raise ValueError(
                        f"could not read Python blob {path} at {commit}"
                    )
                size = int(parts[2])
                content = process.stdout.read(size)
                terminator = process.stdout.read(1)
                if len(content) != size or terminator != b"\n":
                    raise ValueError(
                        f"truncated Python blob {path} at {commit}"
                    )
                yield path, content
            process.stdin.close()
            return_code = process.wait()
            if return_code != 0:
                assert process.stderr is not None
                detail = process.stderr.read().decode(errors="replace").strip()
                raise subprocess.CalledProcessError(
                    return_code,
                    process.args,
                    stderr=detail,
                )
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def _decode_python(self, content: bytes) -> str:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(content).readline)
        return content.decode(encoding)
