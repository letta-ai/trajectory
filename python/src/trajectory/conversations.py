"""Imported conversations, separate from agent trajectory records and APIs."""

from __future__ import annotations

import json
from typing import Literal, TypedDict, Union

from ._client import _run_bridge
from ._errors import NormalizationError, TrajectoryRuntimeError

ConversationSource = Literal["slack"]


class _ConversationParticipantOptional(TypedDict, total=False):
    bot: Literal[True]


class ConversationParticipant(_ConversationParticipantOptional):
    id: str


class _ConversationMetaOptional(TypedDict, total=False):
    channel_name: str


class ConversationMetaRecord(_ConversationMetaOptional):
    role: Literal["meta"]
    source: str
    channel: str
    participants: dict[str, ConversationParticipant]


class _ConversationMessageOptional(TypedDict, total=False):
    reactions: dict[str, int]


class ConversationMessage(_ConversationMessageOptional):
    id: str
    speaker: str
    content: str
    timestamp: str


class ConversationPost(ConversationMessage, total=False):
    """A top-level post; ``replies`` is present only when the thread has replies."""

    replies: list[ConversationMessage]


class ConversationThreadFragment(TypedDict):
    """Replies whose root was not in the input; ``id`` is the root's source ID."""

    id: str
    missing_root: Literal[True]
    replies: list[ConversationMessage]


ConversationRecord = Union[ConversationMetaRecord, ConversationPost, ConversationThreadFragment]


class ConversationDiagnostic(TypedDict):
    code: Literal[
        "slack_message_dropped", "slack_duplicate_message", "slack_conflicting_message", "slack_missing_root"
    ]
    message: str


class NormalizeConversationResult(TypedDict):
    records: list[ConversationRecord]
    diagnostics: list[ConversationDiagnostic]


def normalize_conversation(
    *,
    source: ConversationSource,
    transcript: str,
    channel: str,
    channel_name: str | None = None,
    users: list[object] | None = None,
) -> NormalizeConversationResult:
    """Normalize one channel's raw messages (JSONL, JSON array, or history response) into one conversation.

    Slack requires ``channel`` to fetch messages and does not echo it back, so the
    caller supplies it, along with an optional readable ``channel_name``. ``users``
    are raw ``users.list`` rows used only for display names and bot flags.
    """
    request: dict[str, object] = {"source": source, "transcript": transcript, "channel": channel}
    if channel_name is not None:
        request["channelName"] = channel_name
    if users is not None:
        request["users"] = users
    return _bridge_request({"conversation": request})


def _bridge_request(request: dict[str, object]) -> dict:
    payload = json.dumps({"version": 1, "requests": [request]}, ensure_ascii=False)
    completed = _run_bridge(payload)
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise TrajectoryRuntimeError("Conversation runtime returned invalid JSON.") from error
    if not isinstance(response, dict) or response.get("version") != 1:
        raise TrajectoryRuntimeError("Conversation runtime protocol version did not match.")
    results = response.get("results")
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise TrajectoryRuntimeError("Conversation runtime returned an invalid result count.")
    item = results[0]
    if item.get("ok") is True and isinstance(item.get("result"), dict):
        return item["result"]
    error = item.get("error")
    if item.get("ok") is False and isinstance(error, dict) and isinstance(error.get("message"), str):
        if error.get("code") == "invalid_input":
            raise NormalizationError("invalid_input", error["message"], input_index=0)
        if error.get("code") == "unknown_source":
            raise NormalizationError("unknown_source", error["message"], input_index=0)
        raise TrajectoryRuntimeError(error["message"])
    raise TrajectoryRuntimeError("Conversation runtime returned an invalid result.")
