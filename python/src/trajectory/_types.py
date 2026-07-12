"""Public typing contract for trajectory inputs and outputs."""

from typing import Literal, TypedDict, Union

TrajectorySource = Literal["claude-code", "codex", "letta", "openhands"]
CheckpointTrajectorySource = Literal["deepagents"]
ApiTrajectorySource = Literal["letta-api"]
AnyTrajectorySource = Literal[
    "claude-code", "codex", "letta", "openhands", "deepagents", "letta-api"
]
ToolResultTruncationStrategy = Literal["head", "head-tail"]
DiagnosticCode = Literal[
    "invalid_json_line",
    "non_object_json_line",
    "injected_context_dropped",
    "noise_record_dropped",
    "sidechain_record_dropped",
    "tool_call_id_synthesized",
    "duplicate_tool_call_id",
    "orphan_tool_result",
    "duplicate_tool_result",
    "unknown_tool_name",
    "tool_arguments_reshaped",
    "tool_arguments_truncated",
    "tool_result_truncated",
    "timestamps_synthesized",
    "timestamps_interpolated",
]
NormalizationErrorCode = Literal[
    "invalid_input",
    "unknown_source",
    "python_unavailable",
    "python_dependency_missing",
    "checkpoint_database_not_found",
    "checkpoint_database_unreadable",
    "checkpoint_read_failed",
    "checkpoint_not_found",
    "checkpoint_messages_missing",
    "invalid_checkpoint_state",
    "letta_api_auth_missing",
    "letta_api_request_failed",
    "letta_api_response_invalid",
    "missing_user_records",
    "missing_assistant_records",
    "invalid_normalized_transcript",
]


class ToolArgumentBounds(TypedDict, total=False):
    maxCharacters: int | None


class ToolResultBounds(TypedDict, total=False):
    maxCharacters: int | None
    strategy: ToolResultTruncationStrategy


class NormalizationBounds(TypedDict, total=False):
    toolArguments: ToolArgumentBounds
    toolResults: ToolResultBounds


class _NormalizeInputOptional(TypedDict, total=False):
    bounds: NormalizationBounds


class NormalizeInput(_NormalizeInputOptional):
    source: TrajectorySource
    transcript: str


class _DeepAgentsCheckpointLocationOptional(TypedDict, total=False):
    checkpointNamespace: str
    checkpointId: str
    pythonExecutable: str


class DeepAgentsCheckpointLocation(_DeepAgentsCheckpointLocationOptional):
    path: str
    threadId: str


class DeepAgentsCheckpointInput(_NormalizeInputOptional):
    source: Literal["deepagents"]
    checkpoint: DeepAgentsCheckpointLocation


class _LettaApiInputOptional(TypedDict, total=False):
    conversationId: str
    agentId: str
    apiKey: str
    baseUrl: str
    bounds: NormalizationBounds


class LettaApiInput(_LettaApiInputOptional):
    source: Literal["letta-api"]


NormalizeRequest = Union[NormalizeInput, DeepAgentsCheckpointInput, LettaApiInput]


class _DiagnosticOptional(TypedDict, total=False):
    inputLine: int
    recordIndex: int
    count: int


class Diagnostic(_DiagnosticOptional):
    code: DiagnosticCode
    message: str


class _MetaOptional(TypedDict, total=False):
    cwd: str
    git_branch: str
    model: str


class MetaRecord(_MetaOptional):
    role: Literal["meta"]
    source: str


class UserRecord(TypedDict):
    role: Literal["user"]
    content: str
    timestamp: str


class ReasoningRecord(TypedDict):
    role: Literal["reasoning"]
    content: str
    timestamp: str


class AssistantMessageRecord(TypedDict):
    role: Literal["assistant"]
    content: str
    timestamp: str


class ToolCall(TypedDict):
    id: str
    name: str
    args: str


class AssistantToolCallRecord(TypedDict):
    role: Literal["assistant"]
    content: None
    tool_calls: list[ToolCall]
    timestamp: str


class ToolResultRecord(TypedDict):
    role: Literal["tool"]
    tool_call_id: str
    content: str
    timestamp: str


NormalizedRecord = Union[
    MetaRecord,
    UserRecord,
    ReasoningRecord,
    AssistantMessageRecord,
    AssistantToolCallRecord,
    ToolResultRecord,
]


class NormalizeResult(TypedDict):
    records: list[NormalizedRecord]
    diagnostics: list[Diagnostic]
