export type TrajectorySource =
  | "claude-code"
  | "codex"
  | "letta"
  | "openhands";

export type TranscriptTrajectorySource = TrajectorySource;

export type CheckpointTrajectorySource = "deepagents";

export type AnyTrajectorySource =
  | TranscriptTrajectorySource
  | CheckpointTrajectorySource;

export interface ToolArgumentBounds {
  /** Maximum Unicode code points in the serialized arguments object. */
  maxCharacters?: number | null;
}

export type ToolResultTruncationStrategy = "head" | "head-tail";

export interface ToolResultBounds {
  /** Maximum Unicode code points in the final stored result. */
  maxCharacters?: number | null;
  strategy?: ToolResultTruncationStrategy;
}

export interface NormalizationBounds {
  toolArguments?: ToolArgumentBounds;
  toolResults?: ToolResultBounds;
}

export interface NormalizeInput {
  source: TranscriptTrajectorySource;
  transcript: string;
  bounds?: NormalizationBounds;
}

export interface DeepAgentsCheckpointLocation {
  /** Path to a SQLite database created by Python LangGraph SqliteSaver. */
  path: string;
  /** LangGraph thread_id. Required because Deep Agents has no standard local store. */
  threadId: string;
  /** LangGraph checkpoint_ns. Defaults to the root namespace (empty string). */
  checkpointNamespace?: string;
  /** Select one checkpoint. When omitted, SqliteSaver selects the latest checkpoint. */
  checkpointId?: string;
  /** Python interpreter containing LangGraph and langgraph-checkpoint-sqlite. */
  pythonExecutable?: string;
}

export interface DeepAgentsCheckpointInput {
  source: "deepagents";
  checkpoint: DeepAgentsCheckpointLocation;
  bounds?: NormalizationBounds;
}

export interface DeepAgentsToolCall {
  id?: string;
  name?: string;
  args: unknown;
}

export interface DeepAgentsHumanMessageData {
  role: "human";
  content: string;
  timestamp?: string;
}

export interface DeepAgentsAIMessageData {
  role: "ai";
  content: string;
  reasoning: string[];
  toolCalls: DeepAgentsToolCall[];
  model?: string;
  timestamp?: string;
}

export interface DeepAgentsToolMessageData {
  role: "tool";
  content: string;
  toolCallId: string;
  timestamp?: string;
}

export type DeepAgentsMessageData =
  | DeepAgentsHumanMessageData
  | DeepAgentsAIMessageData
  | DeepAgentsToolMessageData;

export interface DeepAgentsCheckpointData {
  checkpointId: string;
  checkpointNamespace: string;
  checkpointTimestamp: string;
  cwd?: string;
  model?: string;
  messages: DeepAgentsMessageData[];
}

export type DiagnosticCode =
  | "invalid_json_line"
  | "non_object_json_line"
  | "injected_context_dropped"
  | "noise_record_dropped"
  | "sidechain_record_dropped"
  | "tool_call_id_synthesized"
  | "duplicate_tool_call_id"
  | "orphan_tool_result"
  | "duplicate_tool_result"
  | "unknown_tool_name"
  | "tool_arguments_reshaped"
  | "tool_arguments_truncated"
  | "tool_result_truncated"
  | "timestamps_synthesized"
  | "timestamps_interpolated";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  inputLine?: number;
  recordIndex?: number;
  count?: number;
}

export interface MetaRecord {
  role: "meta";
  source: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
}

export interface UserRecord {
  role: "user";
  content: string;
  timestamp: string;
}

export interface ReasoningRecord {
  role: "reasoning";
  content: string;
  timestamp: string;
}

export interface AssistantMessageRecord {
  role: "assistant";
  content: string;
  timestamp: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface AssistantToolCallRecord {
  role: "assistant";
  content: null;
  tool_calls: ToolCall[];
  timestamp: string;
}

export interface ToolResultRecord {
  role: "tool";
  tool_call_id: string;
  content: string;
  timestamp: string;
}

export type NormalizedRecord =
  | MetaRecord
  | UserRecord
  | ReasoningRecord
  | AssistantMessageRecord
  | AssistantToolCallRecord
  | ToolResultRecord;

export type NormalizedTranscript = NormalizedRecord[];

export interface NormalizeResult {
  records: NormalizedTranscript;
  diagnostics: Diagnostic[];
}

export type NormalizationErrorCode =
  | "invalid_input"
  | "unknown_source"
  | "python_unavailable"
  | "python_dependency_missing"
  | "checkpoint_database_not_found"
  | "checkpoint_database_unreadable"
  | "checkpoint_read_failed"
  | "checkpoint_not_found"
  | "checkpoint_messages_missing"
  | "invalid_checkpoint_state"
  | "missing_user_records"
  | "missing_assistant_records"
  | "invalid_normalized_transcript";

export class NormalizationError extends Error {
  readonly code: NormalizationErrorCode;

  constructor(code: NormalizationErrorCode, message: string) {
    super(message);
    this.name = "NormalizationError";
    this.code = code;
  }
}
