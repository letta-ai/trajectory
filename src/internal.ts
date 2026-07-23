import type { ResolvedNormalizationBounds } from "./bounds.js";
import type { ResolvedNormalizationFilters } from "./filters.js";
import type {
  Diagnostic,
  NormalizedRecord,
  TranscriptTrajectorySource,
} from "./types.js";

interface DecodedEventBase {
  timestamp?: Date;
  inputLine?: number;
  model?: string;
  /**
   * Source-native, arrival-order-independent identity of the source record
   * this event was decoded from (for example a Claude Code line `uuid`, a Letta
   * Code `source_message_id`, or an OpenHands event `id`). Adapters set this
   * only when the source exposes a stable per-record identifier.
   */
  sourceRecordId?: string;
  /**
   * Source-native monotonic ordering key within the group when the source
   * exposes one. Used only as an order tie-break.
   */
  sourceSequence?: number;
  /**
   * Stable source-native location used as a fallback identity anchor when no
   * native record id exists but a durable offset does. Its unit is given by
   * {@link sourceAnchorKind}: an absolute UTF-8 byte offset (`byte`, chunkable
   * via `sourceContext.baseByteOffset`) or a whole-decode ordinal (`ordinal`).
   */
  sourceOffset?: number;
  /** Unit of {@link sourceOffset}. `baseByteOffset` applies only to `byte`. */
  sourceAnchorKind?: "byte" | "ordinal";
  /**
   * Index of this component within its own source record, starting at 0. A
   * single source record (one line/message) may expand into multiple canonical
   * components (assistant text plus several tool calls); this disambiguates them
   * deterministically and identically across duplicate occurrences.
   */
  componentIndex?: number;
}

export interface DecodedMessageEvent extends DecodedEventBase {
  type: "message";
  role: "user" | "assistant";
  content: string;
}

export interface DecodedReasoningEvent extends DecodedEventBase {
  type: "reasoning";
  content: string;
}

export interface DecodedToolCallEvent extends DecodedEventBase {
  type: "tool_call";
  id?: string;
  name?: string;
  args: string;
}

export interface DecodedToolResultEvent extends DecodedEventBase {
  type: "tool_result";
  callId?: string;
  content: string;
}

export type DecodedEvent =
  | DecodedMessageEvent
  | DecodedReasoningEvent
  | DecodedToolCallEvent
  | DecodedToolResultEvent;

export interface SessionContext {
  source: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  createdAt?: Date;
  durationSeconds?: number;
  /**
   * Source-native session/conversation identity shared by every record in this
   * decode (for example a Claude Code `sessionId`). Falls back to a stable
   * source-local sentinel downstream when a source has one implicit group.
   */
  sourceGroupId?: string;
}

export interface DecodedSession {
  events: DecodedEvent[];
  context: SessionContext;
  diagnostics: Diagnostic[];
}

export interface SourceAdapter {
  source: TranscriptTrajectorySource;
  decode(transcript: string): DecodedSession;
}

/**
 * Source-native identity basis captured for a single emitted body record, used
 * to derive canonical identity fields deterministically. `null` entries (the
 * leading meta record) receive a synthetic identity.
 */
export interface CanonicalSourceBasis {
  sourceRecordId?: string;
  sourceSequence?: number;
  sourceOffset?: number;
  sourceAnchorKind?: "byte" | "ordinal";
  componentIndex: number;
  /**
   * Ordinal of this component among components of the same canonical type within
   * its source record (0-based). Used to disambiguate otherwise-indistinguishable
   * components (for example two assistant text blocks) in a way that is stable
   * under insertion of other-typed components and identical across duplicate
   * occurrences.
   */
  componentTypeOrdinal: number;
  /** ISO-8601 source event time, when the source supplied one. */
  sourceTimestamp?: string;
}

/**
 * Rich normalization output shared by the trajectory-v1 and canonical views.
 * `bases` and `recordTimestamps` are index-aligned to `records`, whose first
 * entry is always the meta record.
 */
export interface InternalNormalization {
  records: NormalizedRecord[];
  bases: (CanonicalSourceBasis | null)[];
  recordTimestamps: (string | null)[];
  context: SessionContext;
  diagnostics: Diagnostic[];
  bounds: ResolvedNormalizationBounds;
  filters: ResolvedNormalizationFilters;
}
