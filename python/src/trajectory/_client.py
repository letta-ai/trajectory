"""Subprocess transport for the bundled trajectory runtime."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from collections.abc import Iterable, Mapping
from functools import lru_cache
from pathlib import Path
from typing import cast

from ._errors import NodeUnavailableError, NormalizationError, TrajectoryRuntimeError
from ._types import (
    NormalizationBounds,
    NormalizationErrorCode,
    NormalizeInput,
    NormalizeRequest,
    NormalizeResult,
    TrajectorySource,
)

_PROTOCOL_VERSION = 1
_MINIMUM_NODE_MAJOR = 20
_CLI_PATH = Path(__file__).parent / "_vendor" / "trajectory-cli.mjs"
DEEP_AGENTS_CODE_DEFAULT_DATABASE_PATH = "~/.deepagents/.state/sessions.db"


def normalize_transcript(
    *,
    source: TrajectorySource,
    transcript: str,
    bounds: NormalizationBounds | None = None,
) -> NormalizeResult:
    """Normalize one native transcript."""

    request: NormalizeInput = {"source": source, "transcript": transcript}
    if bounds is not None:
        request["bounds"] = bounds
    return normalize_many([request])[0]


def normalize_checkpoint(
    *,
    path: str | Path,
    thread_id: str,
    checkpoint_namespace: str = "",
    checkpoint_id: str | None = None,
    bounds: NormalizationBounds | None = None,
    python_executable: str | None = None,
) -> NormalizeResult:
    """Normalize a Python Deep Agents SDK LangGraph SQLite checkpoint."""

    checkpoint: dict[str, str] = {
        "path": str(path),
        "threadId": thread_id,
        "checkpointNamespace": checkpoint_namespace,
        "pythonExecutable": python_executable or sys.executable,
    }
    if checkpoint_id is not None:
        checkpoint["checkpointId"] = checkpoint_id
    request: NormalizeRequest = {
        "source": "deepagents",
        "checkpoint": checkpoint,
    }
    if bounds is not None:
        request["bounds"] = bounds
    return normalize_many([request])[0]


def normalize_deepagents_code(
    *,
    thread_id: str,
    checkpoint_namespace: str = "",
    checkpoint_id: str | None = None,
    bounds: NormalizationBounds | None = None,
    python_executable: str | None = None,
) -> NormalizeResult:
    """Normalize one explicitly selected Deep Agents Code local thread."""

    if not isinstance(thread_id, str) or not thread_id:
        raise NormalizationError(
            "invalid_input", "Deep Agents Code thread_id must be a non-empty string."
        )
    result = normalize_checkpoint(
        path=Path.home() / ".deepagents" / ".state" / "sessions.db",
        thread_id=thread_id,
        checkpoint_namespace=checkpoint_namespace,
        checkpoint_id=checkpoint_id,
        bounds=bounds,
        python_executable=python_executable,
    )
    meta, *records = result["records"]
    return {
        "records": [{**meta, "source": "deepagents-code"}, *records],
        "diagnostics": result["diagnostics"],
    }


def normalize_many(inputs: Iterable[NormalizeRequest]) -> list[NormalizeResult]:
    """Normalize multiple transcript or checkpoint requests in one Node.js subprocess.

    Results preserve input order. If a transcript fails, ``NormalizationError``
    identifies its zero-based ``input_index``.
    """

    raw_requests = list(inputs)
    if not raw_requests:
        return []
    requests: list[dict[str, object]] = []
    for index, request in enumerate(raw_requests):
        if not isinstance(request, Mapping):
            raise TypeError(f"Input {index} must be a mapping.")
        normalized_request = dict(request)
        if normalized_request.get("source") == "deepagents":
            checkpoint = normalized_request.get("checkpoint")
            if isinstance(checkpoint, Mapping):
                normalized_checkpoint = dict(checkpoint)
                normalized_checkpoint.setdefault("pythonExecutable", sys.executable)
                normalized_request["checkpoint"] = normalized_checkpoint
        requests.append(normalized_request)

    payload = json.dumps(
        {"version": _PROTOCOL_VERSION, "requests": requests},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    completed = _run_bridge(payload)
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise TrajectoryRuntimeError(
            "The trajectory runtime returned invalid JSON."
        ) from error

    if not isinstance(response, dict) or response.get("version") != _PROTOCOL_VERSION:
        raise TrajectoryRuntimeError(
            "The trajectory runtime protocol version did not match."
        )
    results = response.get("results")
    if not isinstance(results, list) or len(results) != len(requests):
        raise TrajectoryRuntimeError(
            "The trajectory runtime returned an invalid result count."
        )

    normalized: list[NormalizeResult] = []
    for index, item in enumerate(results):
        if not isinstance(item, dict):
            raise TrajectoryRuntimeError(
                f"The trajectory runtime returned an invalid result at index {index}."
            )
        if item.get("ok") is True and isinstance(item.get("result"), dict):
            normalized.append(cast(NormalizeResult, item["result"]))
            continue
        normalization_error = item.get("error")
        if item.get("ok") is False and isinstance(normalization_error, dict):
            code = normalization_error.get("code")
            message = normalization_error.get("message")
            if isinstance(code, str) and isinstance(message, str):
                if code == "internal_error":
                    raise TrajectoryRuntimeError(
                        f"Trajectory runtime error for input {index}: {message}"
                    )
                raise NormalizationError(
                    cast(NormalizationErrorCode, code), message, input_index=index
                )
        raise TrajectoryRuntimeError(
            f"The trajectory runtime returned an invalid result at index {index}."
        )
    return normalized


def _run_bridge(payload: str) -> subprocess.CompletedProcess[str]:
    node = _node_executable()
    if not _CLI_PATH.is_file():
        raise TrajectoryRuntimeError(
            f"The bundled trajectory runtime is missing at {_CLI_PATH}."
        )
    try:
        return subprocess.run(
            [node, str(_CLI_PATH)],
            input=payload,
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or f"exit status {error.returncode}"
        raise TrajectoryRuntimeError(
            f"The trajectory runtime failed: {detail}"
        ) from error
    except OSError as error:
        raise TrajectoryRuntimeError(
            f"Could not execute the trajectory runtime: {error}"
        ) from error


@lru_cache(maxsize=1)
def _node_executable() -> str:
    node = shutil.which("node")
    if node is None:
        raise NodeUnavailableError("trajectory requires Node.js 20 or newer.")
    try:
        completed = subprocess.run(
            [node, "--version"],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise NodeUnavailableError(
            "trajectory could not determine the installed Node.js version."
        ) from error
    match = re.fullmatch(r"v(\d+)(?:\.\d+){2}\s*", completed.stdout)
    if match is None or int(match.group(1)) < _MINIMUM_NODE_MAJOR:
        version = completed.stdout.strip() or "unknown"
        raise NodeUnavailableError(
            f"trajectory requires Node.js 20 or newer; found {version}."
        )
    return node
