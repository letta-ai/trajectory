#!/usr/bin/env python3
"""Generate a checkpoint by running the real Deep Agents SDK without a network call."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.sqlite import SqliteSaver


THREAD_ID = "deepagents-sdk-test"


class DeterministicChatModel(BaseChatModel):
    """Minimal tool-capable model used to exercise Deep Agents hermetically."""

    call_count: int = 0

    @property
    def _llm_type(self) -> str:
        return "trajectory-deepagents-sdk-test"

    def bind_tools(
        self,
        tools: Any,
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> DeterministicChatModel:
        del tools, tool_choice, kwargs
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        del messages, stop, run_manager, kwargs
        self.call_count += 1
        if self.call_count == 1:
            message = AIMessage(
                content="Calling the SDK verification tool.",
                tool_calls=[
                    {
                        "name": "sdk_verification_tool",
                        "args": {},
                        "id": "sdk-call-1",
                        "type": "tool_call",
                    }
                ],
            )
        else:
            message = AIMessage(content="Deep Agents SDK checkpoint complete.")
        return ChatResult(generations=[ChatGeneration(message=message)])


@tool
def sdk_verification_tool() -> str:
    """Return a deterministic value for the SDK checkpoint test."""

    return "Deep Agents SDK tool result"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate_sdk_checkpoint.py OUTPUT")
    output = Path(sys.argv[1])
    for candidate in (output, Path(f"{output}-wal"), Path(f"{output}-shm")):
        candidate.unlink(missing_ok=True)

    with SqliteSaver.from_conn_string(str(output)) as saver:
        agent = create_deep_agent(
            model=DeterministicChatModel(),
            tools=[sdk_verification_tool],
            checkpointer=saver,
        )
        agent.invoke(
            {"messages": [{"role": "user", "content": "Run the SDK test tool."}]},
            {"configurable": {"thread_id": THREAD_ID}},
        )

    print(output)


if __name__ == "__main__":
    main()
