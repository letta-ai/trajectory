import type { ResolvedNormalizationBounds } from "./bounds.js";

export type TrajectorySource =
  | "claude-code"
  | "codex"
  | "hermes"
  | "letta"
  | "openclaw"
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

/**
 * Optional caller-supplied source context. Lets the Cloud normalizer worker
 * anchor identity absolutely across chunked uploads of one append-only source
 * generation, independent of how the transcript was segmented.
 */
export interface SourceContext {
  /**
   * Authoritative logical source group/session id. Fills missing adapter-detected
   * context (for example a Codex chunk without its `session_meta`). If both an
   * adapter-detected group and this value are present and disagree, normalization
   * fails so the upload can be quarantined.
   */
  groupId?: string;
  /**
   * Absolute UTF-8 byte offset of this transcript within its source generation.
   * Added to each record's in-transcript byte offset so location-derived identity
   * is stable regardless of chunk boundaries.
   */
  baseByteOffset?: number;
  /**
   * Marks this transcript as one chunk of a larger conversation (not a complete
   * transcript), enabling partial-transcript semantics: whole-conversation
   * invariants are relaxed (no required user/assistant turn; a tool result whose
   * call lived in another chunk is kept). This is independent of the byte offset —
   * an initial chunk at offset 0 can still be partial (and still emits meta). A
   * non-zero `baseByteOffset` already implies a continuation and is treated as
   * partial. Full-transcript callers omit this and stay strict.
   */
  partial?: boolean;
}

export interface NormalizeInput {
  source: TranscriptTrajectorySource;
  transcript: string;
  bounds?: NormalizationBounds;
  sourceContext?: SourceContext;
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
  /** LangGraph thread_id the checkpoint was selected by; part of the group identity. */
  threadId: string;
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

/**
 * Canonical record type, reusing the trajectory-v1 role vocabulary rather than
 * introducing a second taxonomy. `assistant-tool-call` is an assistant record
 * carrying tool calls; `tool` is a tool result.
 */
export type CanonicalRecordType =
  | "meta"
  | "user"
  | "reasoning"
  | "assistant"
  | "assistant-tool-call"
  | "tool";

/**
 * How `stable_source_record_id` was derived, so the worker knows how
 * confidently it can interpret identity and content conflicts:
 * - `native`: a source-native per-record identifier.
 * - `location`: a stable source-native location anchor (no native id).
 * - `content`: content-addressed fallback — supports exact-duplicate dedup only,
 *   NOT conflicting-version detection.
 * - `synthetic`: a deterministic identity generated for the leading meta record.
 */
export type SourceIdentityKind = "native" | "location" | "content" | "synthetic";

/**
 * One canonical, ingestion-ready record. The library owns every field here; the
 * Cloud normalizer worker owns tenancy, raw-upload lineage, ingestion identity,
 * `content_version`, `config_hash`, and the final ClickHouse `record_index`.
 *
 * Identity fields are deterministic and independent of transport-arrival order.
 * The worker deduplicates by `(source_id, record_id)`, orders logically by
 * `(source_order_id, component_index)`, then assigns the authoritative
 * ClickHouse `record_index`.
 */
export interface CanonicalRecord {
  /** Source type value, e.g. `claude-code`. The worker writes it to the row. */
  source_type: string;
  /** Source-native session/conversation identity, or a stable sentinel. */
  source_group_id: string;
  /** Stable, arrival-order-independent identity of the originating source record. */
  stable_source_record_id: string;
  /** How `stable_source_record_id` was derived. */
  source_identity_kind: SourceIdentityKind;
  /** Fixed-width, lexicographically sortable logical order key within the group. */
  source_order_id: string;
  /**
   * Index of this component within its source record. Worker sort input paired
   * with `source_order_id`; NOT a ClickHouse column.
   */
  component_index: number;
  record_type: CanonicalRecordType;
  /** Per-canonical-record dedup identity: sha256 hex of an immutable id tuple. */
  record_id: string;
  /** sha256 hex of `record_json`. */
  record_hash: string;
  /** sha256 hex of the canonical semantic content, excluding transport metadata. */
  content_hash: string;
  /** Original source event time, when present. Descriptive only, never a cursor. */
  source_timestamp: string | null;
  /** Canonical record time (may be synthesized/interpolated). Descriptive only. */
  record_timestamp: string | null;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_arguments_json: string | null;
  tool_result_json: string | null;
  /** Lossless canonical JSON of the emitted trajectory-v1 record. */
  record_json: string;
}

export interface CanonicalResult {
  records: CanonicalRecord[];
  diagnostics: Diagnostic[];
  /** Equal to the exported `NORMALIZER_VERSION`. */
  normalizer_version: string;
  /** Equal to the exported `CANONICAL_SCHEMA_VERSION`. */
  canonical_schema_version: number;
  /**
   * The resolved, output-affecting configuration the caller may not otherwise
   * observe (defaults are applied here). The worker owns `config_hash`; this
   * lets it hash a canonical serialization of the effective configuration.
   */
  config: {
    bounds: ResolvedNormalizationBounds;
  };
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
  | "invalid_normalized_transcript"
  | "source_group_required"
  | "source_group_conflict";

export class NormalizationError extends Error {
  readonly code: NormalizationErrorCode;

  constructor(code: NormalizationErrorCode, message: string) {
    super(message);
    this.name = "NormalizationError";
    this.code = code;
  }
}
