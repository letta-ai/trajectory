"""Imported conversations, separate from agent trajectory records and APIs."""

from __future__ import annotations

import json
import re
from typing import Literal, TypedDict, Union

from ._client import _run_bridge
from ._errors import NormalizationError, TrajectoryRuntimeError

ConversationSource = Literal["slack"]


class _ConversationMetaOptional(TypedDict, total=False):
    source_metadata: dict[str, str]


class ConversationMetaRecord(_ConversationMetaOptional):
    role: Literal["meta"]
    source: str
    conversation_id: str


class _ConversationSpeakerOptional(TypedDict, total=False):
    name: str


class ConversationSpeaker(_ConversationSpeakerOptional):
    id: str


class ConversationReaction(TypedDict):
    name: str
    count: int
    users: list[str]


class ConversationMessageMetadata(TypedDict, total=False):
    reactions: list[ConversationReaction]


class _ConversationMessageOptional(TypedDict, total=False):
    metadata: ConversationMessageMetadata


class ConversationMessageRecord(_ConversationMessageOptional):
    role: Literal["message"]
    id: str
    speaker: ConversationSpeaker
    content: str
    timestamp: str


ConversationRecord = Union[ConversationMetaRecord, ConversationMessageRecord]


class ConversationDiagnostic(TypedDict):
    code: Literal["slack_message_dropped", "slack_duplicate_message"]
    message: str


class NormalizeConversationResult(TypedDict):
    records: list[ConversationRecord]
    diagnostics: list[ConversationDiagnostic]


_SLACK_TS = re.compile(r"^(?!0\d)\d{1,12}\.\d{6}$")


def group_slack_messages(
    messages: list[object], *, team: str, channel: str, users: list[object] | None = None
) -> list[dict[str, object]]:
    """Group one channel's raw Slack messages into thread envelopes for normalize_conversation.

    Slack requires ``channel`` to fetch messages and does not echo it back, so the
    caller supplies it. Messages pass through untouched; the adapter validates them.
    """
    threads: dict[str, list[object]] = {}
    for raw in messages:
        if not isinstance(raw, dict):
            raise NormalizationError("invalid_input", "Slack messages must be objects.", input_index=0)
        key = raw.get("thread_ts", raw.get("ts"))
        if not isinstance(key, str) or not _SLACK_TS.match(key):
            raise NormalizationError("invalid_input", "Invalid Slack message timestamp.", input_index=0)
        threads.setdefault(key, []).append(raw)
    context: dict[str, object] = {"team": team, "channel": channel}
    if users is not None:
        context["users"] = users
    return [
        {**context, "thread_ts": thread_ts, "messages": group}
        for thread_ts, group in sorted(threads.items(), key=lambda item: int(item[0].replace(".", "")))
    ]


def normalize_conversation(*, source: ConversationSource, transcript: str) -> NormalizeConversationResult:
    """Normalize one thread envelope; does not change normalize_transcript."""
    payload = json.dumps({"version": 1, "requests": [{"conversation": {
        "source": source, "transcript": transcript,
    }}]}, ensure_ascii=False)
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
