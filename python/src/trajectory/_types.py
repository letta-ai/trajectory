"""Public typing contract for trajectory inputs and outputs."""

from typing import Literal, TypedDict, Union

TrajectorySource = Literal[
    "claude-code", "codex", "copilot-cli", "cursor", "dsh", "droid", "gemini-cli", "hermes", "letta-code", "omp", "openclaw", "opencode", "openhands", "pi"
]
CheckpointTrajectorySource = Literal["deepagents"]
AnyTrajectorySource = Literal[
    "claude-code", "codex", "copilot-cli", "cursor", "dsh", "droid", "gemini-cli", "hermes", "letta-code", "omp", "openclaw", "opencode", "openhands", "pi", "deepagents"
]
ToolResultTruncationStrategy = Literal["head", "head-tail"]
ToolResultPolicy = Literal["include", "omit"]
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
    "listing_unavailable",
    "missing_user_records",
    "missing_assistant_records",
    "invalid_normalized_transcript",
    "source_group_required",
    "source_group_conflict",
]


class _TrajectoryListingOptional(TypedDict, total=False):
    updatedAt: str
    title: str
    sizeBytes: int


class TrajectoryListing(_TrajectoryListingOptional):
    id: str
    path: str


class _ListTrajectoriesResultOptional(TypedDict, total=False):
    nextCursor: str


class ListTrajectoriesResult(_ListTrajectoriesResultOptional):
    items: list[TrajectoryListing]


class ToolArgumentBounds(TypedDict, total=False):
    maxCharacters: int | None


class ToolResultBounds(TypedDict, total=False):
    maxCharacters: int | None
    strategy: ToolResultTruncationStrategy


class NormalizationBounds(TypedDict, total=False):
    toolArguments: ToolArgumentBounds
    toolResults: ToolResultBounds


class NormalizationFilters(TypedDict, total=False):
    toolResults: ToolResultPolicy


class SourceContext(TypedDict, total=False):
    groupId: str
    baseByteOffset: int
    partial: bool


class _NormalizeInputOptional(TypedDict, total=False):
    bounds: NormalizationBounds
    filters: NormalizationFilters
    sourceContext: SourceContext


class NormalizeInput(_NormalizeInputOptional):
    source: TrajectorySource
    transcript: str


class _DeepAgentsCheckpointLocationOptional(TypedDict, total=False):
    path: str
    pythonExecutable: str


class DeepAgentsCheckpointLocation(_DeepAgentsCheckpointLocationOptional):
    threadId: str


class _DeepAgentsCheckpointInputOptional(TypedDict, total=False):
    bounds: NormalizationBounds
    filters: NormalizationFilters


class DeepAgentsCheckpointInput(_DeepAgentsCheckpointInputOptional):
    source: Literal["deepagents"]
    checkpoint: DeepAgentsCheckpointLocation


NormalizeRequest = Union[NormalizeInput, DeepAgentsCheckpointInput]


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


class _ToolResultOptional(TypedDict, total=False):
    ok: bool


class ToolResultRecord(_ToolResultOptional):
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
