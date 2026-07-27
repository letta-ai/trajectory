import { createHash } from "node:crypto";
import type { ResolvedNormalizationBounds } from "./bounds.js";
import type { CanonicalSourceBasis, InternalNormalization } from "./internal.js";
import type {
  CanonicalRecord,
  CanonicalRecordType,
  CanonicalResult,
  NormalizedRecord,
  SourceIdentityKind,
} from "./types.js";
import { CANONICAL_SCHEMA_VERSION, NORMALIZER_VERSION } from "./version.js";

export const GROUP_SENTINEL = "default";
const META_ORDER_TIMESTAMP = "0000-00-00T00:00:00.000Z";
// Missing-time records form one deterministic bucket that sorts before any real
// timestamp within the group; sequence and stable id order them within it.
const MISSING_TIME_SENTINEL = "0000-00-00T00:00:00.001Z";
const SEQUENCE_WIDTH = 20;

export interface CanonicalOptions {
  /** Resolved source group id (overrides adapter-detected context). */
  groupId: string;
  /** Absolute base byte offset added to byte-anchored locations for chunked uploads. */
  baseByteOffset: number;
  /**
   * Whether to emit the leading meta record. The worker sets this false for a
   * continuation chunk (baseByteOffset > 0): its meta would share the group's
   * constant meta identity but carry different session context, creating a false
   * conflicting-version. The authoritative meta is emitted with the initial chunk.
   */
  emitMeta: boolean;
}

/**
 * Project a full internal normalization into canonical, ingestion-ready records.
 *
 * Identity is derived only from source-native signals (never from content or
 * transport-arrival position), so the fields here are stable across re-runs and
 * across the order in which the worker coalesces upload chunks. The library
 * preserves emitted order; the worker sorts by `(source_order_id,
 * component_index)` and assigns the authoritative ClickHouse `record_index`.
 */
export function buildCanonicalRecords(
  internal: InternalNormalization,
  options: CanonicalOptions,
): CanonicalRecord[] {
  const sourceType = internal.context.source;
  const groupId = options.groupId;

  const projected = options.emitMeta
    ? internal.records.map((record, index) => ({ record, index }))
    : internal.records
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => record.role !== "meta");

  return projected.map(({ record, index }) => {
    const basis = internal.bases[index] ?? null;
    const recordTimestamp = internal.recordTimestamps[index] ?? null;
    const type = recordType(record);
    const contentHash = sha256Hex(
      canonicalJson({ type, content: semanticContent(record, type) }),
    );

    const identity = deriveIdentity(
      type,
      groupId,
      basis,
      contentHash,
      options.baseByteOffset,
    );
    const componentIndex = basis?.componentIndex ?? 0;
    const componentKey = componentKeyFor(record, type, basis);
    const recordJson = canonicalJson(record);
    const sourceTimestamp = basis?.sourceTimestamp ?? null;

    const flat = flattenFields(record, type);
    return {
      source_type: sourceType,
      source_group_id: groupId,
      stable_source_record_id: identity.stableSourceRecordId,
      source_identity_kind: identity.kind,
      source_order_id: buildOrderId(
        type,
        sourceTimestamp,
        basis,
        identity.stableSourceRecordId,
      ),
      component_index: componentIndex,
      record_type: type,
      record_id: sha256Hex(
        canonicalJson([groupId, identity.stableSourceRecordId, componentKey]),
      ),
      record_hash: sha256Hex(recordJson),
      content_hash: contentHash,
      source_timestamp: sourceTimestamp,
      record_timestamp: recordTimestamp,
      content: flat.content,
      tool_call_id: flat.toolCallId,
      tool_name: flat.toolName,
      tool_arguments_json: flat.toolArgumentsJson,
      tool_result_json: flat.toolResultJson,
      tool_result_ok: flat.toolResultOk,
      record_json: recordJson,
    };
  });
}

interface DerivedIdentity {
  stableSourceRecordId: string;
  kind: SourceIdentityKind;
}

function deriveIdentity(
  type: CanonicalRecordType,
  groupId: string,
  basis: CanonicalSourceBasis | null,
  contentHash: string,
  baseByteOffset: number,
): DerivedIdentity {
  if (type === "meta") {
    return { stableSourceRecordId: "meta", kind: "synthetic" };
  }
  if (basis?.sourceRecordId !== undefined && basis.sourceRecordId !== "") {
    return { stableSourceRecordId: basis.sourceRecordId, kind: "native" };
  }
  if (basis?.sourceOffset !== undefined) {
    // `baseByteOffset` anchors byte offsets absolutely across chunked uploads;
    // it must not be applied to ordinal anchors. The unit is part of the identity
    // tuple so byte and ordinal anchors can never collide.
    const anchorKind = basis.sourceAnchorKind ?? "ordinal";
    const value =
      anchorKind === "byte" ? basis.sourceOffset + baseByteOffset : basis.sourceOffset;
    return {
      stableSourceRecordId: sha256Hex(`${groupId}|${anchorKind}|${value}`),
      kind: "location",
    };
  }
  if (basis?.sourceSequence !== undefined) {
    return {
      stableSourceRecordId: sha256Hex(`${groupId}|seq|${basis.sourceSequence}`),
      kind: "location",
    };
  }
  // Content-addressed fallback: supports exact-duplicate dedup only. It cannot
  // honestly detect a conflicting version of the same logical record, so it is
  // flagged as `content` for the worker's conflict policy.
  const componentIndex = basis?.componentIndex ?? 0;
  return {
    stableSourceRecordId: sha256Hex(
      `${groupId}|content|${type}|${contentHash}|${componentIndex}`,
    ),
    kind: "content",
  };
}

function buildOrderId(
  type: CanonicalRecordType,
  sourceTimestamp: string | null,
  basis: CanonicalSourceBasis | null,
  stableSourceRecordId: string,
): string {
  const rank = type === "meta" ? "0" : "1";
  // Never derive order from record_timestamp: it can be synthesized from array
  // position and would make source_order_id depend on transport-arrival order.
  const timestamp =
    type === "meta" ? META_ORDER_TIMESTAMP : (sourceTimestamp ?? MISSING_TIME_SENTINEL);
  const sequence =
    basis?.sourceSequence !== undefined
      ? String(basis.sourceSequence).padStart(SEQUENCE_WIDTH, "0")
      : "0".repeat(SEQUENCE_WIDTH);
  return `${rank}|${timestamp}|${sequence}|${stableSourceRecordId}`;
}

function recordType(record: NormalizedRecord): CanonicalRecordType {
  switch (record.role) {
    case "meta":
      return "meta";
    case "user":
      return "user";
    case "reasoning":
      return "reasoning";
    case "tool":
      return "tool";
    default:
      return "tool_calls" in record ? "assistant-tool-call" : "assistant";
  }
}

/**
 * Semantic component key for `record_id`. Tool calls/results are keyed by their
 * tool_call_id (a native semantic id). Messages/reasoning can repeat within one
 * source record without a native id, so they always carry a type-local ordinal
 * (`message:0`) — included even when there is currently only one, so that a
 * conflicting version which changes cardinality (one reasoning block becomes
 * two) does not shift the original record's `record_id`.
 */
function componentKeyFor(
  record: NormalizedRecord,
  type: CanonicalRecordType,
  basis: CanonicalSourceBasis | null,
): string {
  const ordinal = basis?.componentTypeOrdinal ?? 0;
  switch (type) {
    case "meta":
      return "meta";
    case "user":
    case "assistant":
      return `message:${ordinal}`;
    case "reasoning":
      return `reasoning:${ordinal}`;
    case "assistant-tool-call":
      return "tool_calls" in record
        ? `tool-call:${record.tool_calls[0]?.id ?? ""}`
        : "tool-call";
    case "tool":
      return record.role === "tool"
        ? `tool-result:${record.tool_call_id}`
        : "tool-result";
  }
}

function semanticContent(
  record: NormalizedRecord,
  type: CanonicalRecordType,
): unknown {
  switch (type) {
    case "meta":
      return record.role === "meta"
        ? {
            source: record.source,
            ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
            ...(record.git_branch !== undefined
              ? { git_branch: record.git_branch }
              : {}),
            ...(record.model !== undefined ? { model: record.model } : {}),
          }
        : {};
    case "user":
    case "reasoning":
    case "assistant":
      return { content: "content" in record ? record.content : null };
    case "assistant-tool-call": {
      if (!("tool_calls" in record)) return {};
      const call = record.tool_calls[0];
      return { name: call?.name ?? "", args: call?.args ?? "" };
    }
    case "tool":
      return record.role === "tool"
        ? { content: record.content, ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}) }
        : { content: null };
  }
}

interface FlatFields {
  content: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolArgumentsJson: string | null;
  toolResultJson: string | null;
  toolResultOk: boolean | null;
}

function flattenFields(
  record: NormalizedRecord,
  type: CanonicalRecordType,
): FlatFields {
  const empty: FlatFields = {
    content: null,
    toolCallId: null,
    toolName: null,
    toolArgumentsJson: null,
    toolResultJson: null,
    toolResultOk: null,
  };
  switch (type) {
    case "user":
    case "reasoning":
    case "assistant":
      return { ...empty, content: "content" in record ? record.content : null };
    case "assistant-tool-call": {
      if (!("tool_calls" in record)) return empty;
      const call = record.tool_calls[0];
      return {
        ...empty,
        toolCallId: call?.id ?? null,
        toolName: call?.name ?? null,
        toolArgumentsJson: call?.args ?? null,
      };
    }
    case "tool":
      return record.role === "tool"
        ? {
            ...empty,
            toolCallId: record.tool_call_id,
            toolResultJson: record.content,
            toolResultOk: record.ok ?? null,
          }
        : empty;
    case "meta":
      return empty;
  }
}

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, item] of entries) sorted[key] = sortKeys(item);
    return sorted;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Assemble the complete canonical result from an internal normalization. */
export function finalizeCanonical(
  internal: InternalNormalization,
  bounds: ResolvedNormalizationBounds,
  options: CanonicalOptions,
): CanonicalResult {
  return {
    records: buildCanonicalRecords(internal, options),
    diagnostics: internal.diagnostics,
    normalizer_version: NORMALIZER_VERSION,
    canonical_schema_version: CANONICAL_SCHEMA_VERSION,
    config: { bounds, filters: internal.filters },
  };
}
