#!/usr/bin/env python3
"""Read a Python LangGraph SQLite checkpoint through LangGraph's public APIs."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


def _emit(payload: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def _fail(code: str, message: str) -> None:
    _emit({"ok": False, "code": code, "message": message})
    raise SystemExit(0)


try:
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from langgraph.checkpoint.sqlite import SqliteSaver
    from langgraph.graph.message import add_messages
    from langgraph.types import Overwrite
except (ImportError, ModuleNotFoundError) as error:
    _fail(
        "python_dependency_missing",
        "Reading Deep Agents checkpoints requires Python packages "
        "langgraph and langgraph-checkpoint-sqlite; install the "
        "letta-trajectory[deepagents] extra in this Python environment "
        f"(import error: {error}).",
    )


def _request() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except (OSError, json.JSONDecodeError) as error:
        _fail("invalid_input", f"Deep Agents checkpoint request is invalid: {error}")
    if not isinstance(value, dict):
        _fail("invalid_input", "Deep Agents checkpoint request must be an object.")
    return value


def _unwrap_snapshot(value: Any) -> Any:
    # DeltaChannel history exposes its decoded snapshot through the public
    # `seed` contract. In current LangGraph releases that value is a namedtuple
    # with one `value` field; avoid importing its private concrete class.
    if (
        isinstance(value, tuple)
        and getattr(value, "_fields", None) == ("value",)
        and value.__class__.__name__.endswith("DeltaSnapshot")
    ):
        return value.value
    return value


def _as_messages(value: Any) -> list[Any]:
    value = _unwrap_snapshot(value)
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def _apply_message_writes(messages: list[Any], writes: Iterable[tuple[Any, str, Any]]) -> list[Any]:
    current = messages
    for _task_id, channel, value in writes:
        if channel != "messages":
            continue
        if isinstance(value, Overwrite):
            current = _as_messages(value.value)
        else:
            current = list(add_messages(current, value))
    return current


def _reconstruct_messages(saver: Any, checkpoint_tuple: Any) -> list[Any]:
    channel_values = checkpoint_tuple.checkpoint.get("channel_values") or {}
    if not isinstance(channel_values, Mapping):
        _fail("invalid_checkpoint_state", "Checkpoint channel_values must be a mapping.")

    if "messages" in channel_values:
        messages = _as_messages(channel_values["messages"])
    else:
        # This is the public LangGraph API for reconstructing a DeltaChannel:
        # it follows only the selected checkpoint's parent chain and returns
        # already-deserialized seed/writes in oldest-to-newest order.
        if not hasattr(saver, "get_delta_channel_history"):
            _fail(
                "python_dependency_missing",
                "This checkpoint requires a LangGraph release with "
                "get_delta_channel_history support; upgrade the deepagents extra.",
            )
        histories = saver.get_delta_channel_history(
            config=checkpoint_tuple.config,
            channels=["messages"],
        )
        history = histories.get("messages", {})
        messages = _as_messages(history.get("seed"))
        messages = _apply_message_writes(messages, history.get("writes", ()))

    return _apply_message_writes(messages, checkpoint_tuple.pending_writes or ())


def _content_parts(content: Any) -> tuple[str, list[str]]:
    if isinstance(content, str):
        return content, []
    if not isinstance(content, (list, tuple)):
        return _stringify(content), []

    text: list[str] = []
    reasoning: list[str] = []
    for block in content:
        if isinstance(block, str):
            text.append(block)
            continue
        if not isinstance(block, Mapping):
            continue
        block_type = block.get("type")
        if block_type == "reasoning":
            value = block.get("reasoning", block.get("text"))
            if isinstance(value, str) and value:
                reasoning.append(value)
        elif block_type in {"text", "input_text", "output_text"} or (
            block_type is None and "text" in block
        ):
            value = block.get("text")
            if isinstance(value, str) and value:
                text.append(value)
    return "\n".join(text), reasoning


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


def _timestamp(message: Any) -> str | None:
    for container in (
        getattr(message, "additional_kwargs", None),
        getattr(message, "response_metadata", None),
    ):
        if not isinstance(container, Mapping):
            continue
        for key in ("timestamp", "created_at", "createdAt"):
            value = container.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _model(message: Any) -> str | None:
    for container in (
        getattr(message, "response_metadata", None),
        getattr(message, "additional_kwargs", None),
    ):
        if not isinstance(container, Mapping):
            continue
        for key in ("model_name", "model", "model_id"):
            value = container.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _reasoning_from_metadata(message: Any) -> list[str]:
    output: list[str] = []
    for container in (
        getattr(message, "additional_kwargs", None),
        getattr(message, "response_metadata", None),
    ):
        if not isinstance(container, Mapping):
            continue
        for key in ("reasoning", "reasoning_content"):
            value = container.get(key)
            if isinstance(value, str) and value and value not in output:
                output.append(value)
    return output


def _message_data(message: Any) -> dict[str, Any] | None:
    timestamp = _timestamp(message)
    if isinstance(message, HumanMessage) or getattr(message, "type", None) == "human":
        content, _ = _content_parts(message.content)
        return {
            "role": "human",
            "content": content,
            **({"timestamp": timestamp} if timestamp else {}),
        }

    if isinstance(message, AIMessage) or getattr(message, "type", None) == "ai":
        content, reasoning = _content_parts(message.content)
        reasoning.extend(
            value for value in _reasoning_from_metadata(message) if value not in reasoning
        )
        calls: list[dict[str, Any]] = []
        for call in getattr(message, "tool_calls", None) or ():
            if not isinstance(call, Mapping):
                continue
            calls.append(
                {
                    "args": _json_safe(call.get("args", {})),
                    **({"id": call["id"]} if isinstance(call.get("id"), str) else {}),
                    **(
                        {"name": call["name"]}
                        if isinstance(call.get("name"), str)
                        else {}
                    ),
                }
            )
        model = _model(message)
        return {
            "role": "ai",
            "content": content,
            "reasoning": reasoning,
            "toolCalls": calls,
            **({"model": model} if model else {}),
            **({"timestamp": timestamp} if timestamp else {}),
        }

    if isinstance(message, ToolMessage) or getattr(message, "type", None) == "tool":
        content, _ = _content_parts(message.content)
        call_id = getattr(message, "tool_call_id", None)
        if not isinstance(call_id, str):
            call_id = ""
        return {
            "role": "tool",
            "content": content,
            "toolCallId": call_id,
            **({"timestamp": timestamp} if timestamp else {}),
        }
    return None


def _context_string(
    channel_values: Mapping[str, Any], metadata: Mapping[str, Any], keys: tuple[str, ...]
) -> str | None:
    for container in (channel_values, metadata):
        for key in keys:
            value = container.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def main() -> None:
    request = _request()
    path_value = request.get("path")
    thread_id = request.get("threadId")
    namespace = request.get("checkpointNamespace", "")
    checkpoint_id = request.get("checkpointId")
    if not isinstance(path_value, str) or not path_value:
        _fail("invalid_input", "Deep Agents checkpoint path is required.")
    if not isinstance(thread_id, str) or not thread_id:
        _fail("invalid_input", "Deep Agents threadId is required.")
    if not isinstance(namespace, str):
        _fail("invalid_input", "Deep Agents checkpointNamespace must be a string.")
    if checkpoint_id is not None and (
        not isinstance(checkpoint_id, str) or not checkpoint_id
    ):
        _fail("invalid_input", "Deep Agents checkpointId must be a non-empty string.")

    path = Path(path_value).expanduser()
    if not path.is_file():
        _fail(
            "checkpoint_database_not_found",
            f"Deep Agents checkpoint database does not exist: {path}",
        )
    if not os.access(path, os.R_OK):
        _fail(
            "checkpoint_database_unreadable",
            f"Deep Agents checkpoint database is not readable: {path}",
        )

    config: dict[str, Any] = {
        "configurable": {
            "thread_id": thread_id,
            "checkpoint_ns": namespace,
            **({"checkpoint_id": checkpoint_id} if checkpoint_id else {}),
        }
    }
    try:
        with SqliteSaver.from_conn_string(str(path)) as saver:
            checkpoint_tuple = saver.get_tuple(config)
            if checkpoint_tuple is None:
                label = f" checkpoint {checkpoint_id!r}" if checkpoint_id else ""
                _fail(
                    "checkpoint_not_found",
                    f"No Deep Agents{label} checkpoint was found for thread "
                    f"{thread_id!r} in namespace {namespace!r}.",
                )
            messages = _reconstruct_messages(saver, checkpoint_tuple)
    except sqlite3.DatabaseError as error:
        _fail("checkpoint_database_unreadable", f"Could not read checkpoint database: {error}")
    except (OSError, ValueError, TypeError, KeyError) as error:
        _fail("checkpoint_read_failed", f"Could not reconstruct Deep Agents checkpoint: {error}")

    serialized_messages = [
        data for message in messages if (data := _message_data(message)) is not None
    ]
    if not serialized_messages:
        _fail(
            "checkpoint_messages_missing",
            "Deep Agents checkpoint did not contain canonical LangChain messages.",
        )

    channel_values = checkpoint_tuple.checkpoint.get("channel_values") or {}
    metadata = checkpoint_tuple.metadata or {}
    selected = checkpoint_tuple.config.get("configurable", {})
    cwd = _context_string(
        channel_values,
        metadata,
        ("cwd", "working_directory", "current_working_directory"),
    )
    model = _context_string(channel_values, metadata, ("model", "model_name", "model_id"))
    if model is None:
        model = next(
            (
                item["model"]
                for item in serialized_messages
                if item.get("role") == "ai" and isinstance(item.get("model"), str)
            ),
            None,
        )

    _emit(
        {
            "ok": True,
            "data": {
                "checkpointId": str(selected.get("checkpoint_id", checkpoint_tuple.checkpoint["id"])),
                "checkpointNamespace": str(selected.get("checkpoint_ns", namespace)),
                "checkpointTimestamp": str(checkpoint_tuple.checkpoint["ts"]),
                "messages": serialized_messages,
                **({"cwd": cwd} if cwd else {}),
                **({"model": model} if model else {}),
            },
        }
    )


if __name__ == "__main__":
    main()
