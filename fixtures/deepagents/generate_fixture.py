#!/usr/bin/env python3
"""Generate checkpoint.db exclusively through Python LangGraph APIs.

The layout mirrors the Deep Agents CLI store (`~/.deepagents/sessions.db`):
every thread lives in the root checkpoint namespace, and distinct sessions are
distinct thread ids.
"""

from __future__ import annotations

import sys
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Overwrite


MAIN_THREAD_ID = "thread-123"
BASIC_THREAD_ID = "thread-basic"
OVERWRITE_THREAD_ID = "thread-overwrite"
OLDER_ID = "00000000-0000-6000-8000-000000000001"
LATEST_ID = "00000000-0000-6000-8000-000000000002"


def checkpoint(
    checkpoint_id: str,
    timestamp: str,
    channel_values: dict[str, object],
    versions: dict[str, str],
) -> dict[str, object]:
    value = empty_checkpoint()
    value["id"] = checkpoint_id
    value["ts"] = timestamp
    value["channel_values"] = channel_values
    value["channel_versions"] = versions
    return value


def thread_config(thread_id: str) -> dict[str, object]:
    return {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}


def main() -> None:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("checkpoint.db")
    output.unlink(missing_ok=True)
    output.with_name(f"{output.name}-wal").unlink(missing_ok=True)
    output.with_name(f"{output.name}-shm").unlink(missing_ok=True)

    seed_messages = [
        HumanMessage(
            content="What is the weather in Paris?",
            id="human-1",
            additional_kwargs={"timestamp": "2026-01-02T03:04:05Z"},
        ),
        AIMessage(
            content=[
                {"type": "reasoning", "reasoning": "I should call the weather tool."},
                {"type": "text", "text": "I will check the weather."},
            ],
            id="ai-1",
            tool_calls=[
                {
                    "name": "weather",
                    "args": {"city": "Paris"},
                    "id": "call-weather-1",
                    "type": "tool_call",
                }
            ],
            response_metadata={
                "model_name": "anthropic:claude-sonnet-4-6",
                "timestamp": "2026-01-02T03:04:06Z",
            },
        ),
    ]

    with SqliteSaver.from_conn_string(str(output)) as saver:
        older = checkpoint(
            OLDER_ID,
            "2026-01-02T03:04:06+00:00",
            {
                "messages": seed_messages,
                "cwd": "/workspace/deep-agent",
            },
            {"messages": "1", "cwd": "1"},
        )
        older_config = saver.put(
            thread_config(MAIN_THREAD_ID),
            older,  # type: ignore[arg-type]
            {"source": "loop", "step": 1, "parents": {}},
            older["channel_versions"],  # type: ignore[arg-type]
        )
        saver.put_writes(
            older_config,
            [
                (
                    "messages",
                    ToolMessage(
                        content="Sunny, 22 C",
                        tool_call_id="call-weather-1",
                        id="tool-1",
                        additional_kwargs={"timestamp": "2026-01-02T03:04:07Z"},
                    ),
                )
            ],
            task_id="00000000-0000-0000-0000-000000000001",
            task_path="pull,weather",
        )

        latest = checkpoint(
            LATEST_ID,
            "2026-01-02T03:04:08+00:00",
            {"cwd": "/workspace/deep-agent"},
            {"messages": "2", "cwd": "2"},
        )
        latest_config = saver.put(
            older_config,
            latest,  # type: ignore[arg-type]
            {
                "source": "loop",
                "step": 2,
                "parents": {},
                "model": "anthropic:claude-sonnet-4-6",
            },
            latest["channel_versions"],  # type: ignore[arg-type]
        )
        saver.put_writes(
            latest_config,
            [
                (
                    "messages",
                    AIMessage(
                        content="It is sunny and 22 C in Paris.",
                        id="ai-2",
                        response_metadata={
                            "model_name": "anthropic:claude-sonnet-4-6",
                            "timestamp": "2026-01-02T03:04:08Z",
                        },
                    ),
                )
            ],
            task_id="00000000-0000-0000-0000-000000000002",
            task_path="pull,model",
        )

        basic = checkpoint(
            "00000000-0000-6000-8000-000000000003",
            "2026-01-02T04:00:00+00:00",
            {
                "messages": [
                    HumanMessage(content="Basic thread", id="basic-human"),
                    AIMessage(content="Basic response", id="basic-ai"),
                ]
            },
            {"messages": "1"},
        )
        saver.put(
            thread_config(BASIC_THREAD_ID),
            basic,  # type: ignore[arg-type]
            {"source": "loop", "step": 1, "parents": {}},
            basic["channel_versions"],  # type: ignore[arg-type]
        )

        overwrite = checkpoint(
            "00000000-0000-6000-8000-000000000004",
            "2026-01-02T05:00:00+00:00",
            {
                "messages": [
                    HumanMessage(content="Original user", id="original-human"),
                    AIMessage(content="Original response", id="original-ai"),
                ]
            },
            {"messages": "1"},
        )
        overwrite_config = saver.put(
            thread_config(OVERWRITE_THREAD_ID),
            overwrite,  # type: ignore[arg-type]
            {"source": "loop", "step": 1, "parents": {}},
            overwrite["channel_versions"],  # type: ignore[arg-type]
        )
        saver.put_writes(
            overwrite_config,
            [
                (
                    "messages",
                    Overwrite(
                        [
                            HumanMessage(content="Replacement user", id="replacement-human"),
                            AIMessage(content="Replacement response", id="replacement-ai"),
                        ]
                    ),
                )
            ],
            task_id="00000000-0000-0000-0000-000000000003",
            task_path="pull,overwrite",
        )

    print(output)


if __name__ == "__main__":
    main()
