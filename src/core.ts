import type {
  CanonicalSourceBasis,
  DecodedEvent,
  DecodedSession,
  InternalNormalization,
  SessionContext,
} from "./internal.js";
import type {
  AssistantMessageRecord,
  AssistantToolCallRecord,
  Diagnostic,
  MetaRecord,
  NormalizedRecord,
  ReasoningRecord,
  ToolResultRecord,
  UserRecord,
} from "./types.js";
import type { ResolvedNormalizationBounds } from "./bounds.js";
import {
  DEFAULT_NORMALIZATION_FILTERS,
  type ResolvedNormalizationFilters,
} from "./filters.js";
import { NormalizationError } from "./types.js";
import { validateTranscript } from "./validate.js";

const ARGS_LEAF_FLOOR = 2_000;
const SYNTH_BASE_MS = Date.UTC(2026, 0, 1);
const SYNTH_STEP_SECONDS = 15;

const NOISE_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification",
];

type BodyRecord = Exclude<NormalizedRecord, MetaRecord>;
type WithoutTimestamp<T> = T extends { timestamp: string }
  ? Omit<T, "timestamp">
  : never;
type UnstampedBodyRecord = WithoutTimestamp<BodyRecord>;

interface OpenCall {
  finalId: string;
  consumed: boolean;
}

interface CallPlanEntry {
  finalId: string;
  renamed: boolean;
  synthesized: boolean;
  sourceId: string;
}

interface ComponentPlan {
  typeOrdinal: number;
}

interface EventPlan {
  /** Pre-assigned tool-call identity, keyed by event index. */
  calls: Map<number, CallPlanEntry>;
  /** Pre-populated tool-call queues by source id; consumed as results link. */
  openCalls: Map<string, OpenCall[]>;
  /** Per source-record component-type ordinal/total, keyed by event index. */
  components: (ComponentPlan | undefined)[];
}

function semanticBucket(event: DecodedEvent): string {
  switch (event.type) {
    case "message":
      return "message";
    case "reasoning":
      return "reasoning";
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "tool_result";
  }
}

function planEvents(events: DecodedEvent[]): EventPlan {
  const calls = new Map<number, CallPlanEntry>();
  const openCalls = new Map<string, OpenCall[]>();
  const usedIds = new Set<string>();
  const occOf: number[] = [];
  const bucketOf: string[] = [];
  let occurrence = -1;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      occOf.push(occurrence);
      bucketOf.push("");
      continue;
    }
    if ((event.componentIndex ?? 0) === 0) occurrence += 1;
    const bucket = semanticBucket(event);
    occOf.push(occurrence);
    bucketOf.push(bucket);

    if (event.type === "tool_call") {
      const sourceId = event.id || `call_${index + 1}`;
      const synthesized = !event.id;
      let finalId = sourceId;
      let renamed = false;
      if (usedIds.has(finalId)) {
        let suffix = 2;
        while (usedIds.has(`${sourceId}__${suffix}`)) suffix += 1;
        finalId = `${sourceId}__${suffix}`;
        renamed = true;
      }
      usedIds.add(finalId);
      const entries = openCalls.get(sourceId) ?? [];
      entries.push({ finalId, consumed: false });
      openCalls.set(sourceId, entries);
      calls.set(index, { finalId, renamed, synthesized, sourceId });
    }
  }

  const seen = new Map<string, number>();
  const components: (ComponentPlan | undefined)[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index] === undefined) {
      components.push(undefined);
      continue;
    }
    const key = `${occOf[index]}:${bucketOf[index]}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    components.push({ typeOrdinal: ordinal });
  }

  return { calls, openCalls, components };
}

interface ArgsResult {
  args: string;
  reshaped: boolean;
  truncated: boolean;
}

interface StringLeaf {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  original: string;
  keep: number;
  currentLength: number;
}

export function normalizeDecodedSession(
  decoded: DecodedSession,
  bounds: ResolvedNormalizationBounds,
  options?: NormalizeInternalOptions,
): {
  records: NormalizedRecord[];
  diagnostics: Diagnostic[];
} {
  const internal = normalizeDecodedSessionInternal(decoded, bounds, options);
  return { records: internal.records, diagnostics: internal.diagnostics };
}

/**
 * Full normalization producing the trajectory-v1 records plus the index-aligned
 * source-identity bases and canonical record timestamps used by the canonical
 * view. The public {@link normalizeDecodedSession} is a thin projection of this.
 */
export interface NormalizeInternalOptions {
  /**
   * Partial-transcript mode: the input is one fragment of a larger conversation,
   * so whole-conversation invariants are relaxed. It does not require
   * user/assistant turns, and a tool result whose call lived outside the fragment
   * is kept (linked by its source call id) instead of dropped.
   */
  partial?: boolean;
  /** Resolved output filters. Internal callers default to compatibility mode. */
  filters?: ResolvedNormalizationFilters;
}

export function normalizeDecodedSessionInternal(
  decoded: DecodedSession,
  bounds: ResolvedNormalizationBounds,
  options?: NormalizeInternalOptions,
): InternalNormalization {
  const partial = options?.partial ?? false;
  const filters = options?.filters ?? DEFAULT_NORMALIZATION_FILTERS;
  const diagnostics = [...decoded.diagnostics];
  const body: UnstampedBodyRecord[] = [];
  const bodyBases: CanonicalSourceBasis[] = [];
  const anchors = new Map<number, Date>();
  const modelCounts = new Map<string, number>();

  // Pre-pass: resolve source-native structure independently of arrival order.
  // Tool-call ids are assigned up front so a tool result links to its call even
  // when it arrives earlier in the transcript (reversed chunks). Component-type
  // ordinals/totals are computed per source-record occurrence.
  const plan = planEvents(decoded.events);

  for (let eventIndex = 0; eventIndex < decoded.events.length; eventIndex += 1) {
    const event = decoded.events[eventIndex];
    if (event === undefined) continue;
    if (event.model) {
      modelCounts.set(event.model, (modelCounts.get(event.model) ?? 0) + 1);
    }

    const record = normalizeEvent(
      event,
      eventIndex,
      body.length + 1,
      plan,
      diagnostics,
      bounds,
      filters,
      partial,
    );
    if (!record) continue;
    const hasTimestamp =
      event.timestamp !== undefined && !Number.isNaN(event.timestamp.getTime());
    if (hasTimestamp && event.timestamp) {
      anchors.set(body.length, event.timestamp);
    }
    const component = plan.components[eventIndex] ?? { typeOrdinal: 0 };
    body.push(record);
    bodyBases.push({
      componentIndex: event.componentIndex ?? 0,
      componentTypeOrdinal: component.typeOrdinal,
      ...(event.sourceRecordId !== undefined
        ? { sourceRecordId: event.sourceRecordId }
        : {}),
      ...(event.sourceSequence !== undefined
        ? { sourceSequence: event.sourceSequence }
        : {}),
      ...(event.sourceOffset !== undefined
        ? { sourceOffset: event.sourceOffset }
        : {}),
      ...(event.sourceAnchorKind !== undefined
        ? { sourceAnchorKind: event.sourceAnchorKind }
        : {}),
      ...(hasTimestamp && event.timestamp
        ? { sourceTimestamp: event.timestamp.toISOString() }
        : {}),
    });
  }

  const roles = new Set(body.map((record) => record.role));
  if (!partial) {
    if (!roles.has("user")) {
      throw new NormalizationError(
        "missing_user_records",
        "Transcript did not contain any normalizable user records.",
      );
    }
    if (!roles.has("assistant")) {
      throw new NormalizationError(
        "missing_assistant_records",
        "Transcript did not contain any normalizable assistant records.",
      );
    }
  }

  const timestamps = fillTimestamps(
    body.length,
    anchors,
    decoded.context,
    diagnostics,
  );
  const stampedBody: BodyRecord[] = body.map((record, index) => {
    const timestamp = timestamps[index];
    if (timestamp === undefined) {
      throw new NormalizationError(
        "invalid_normalized_transcript",
        `Could not assign a timestamp to normalized record ${index}.`,
      );
    }
    return { ...record, timestamp } as BodyRecord;
  });

  const meta = buildMeta(decoded.context, modelCounts);
  const records: NormalizedRecord[] = [meta, ...stampedBody];
  validateTranscript(records, { partial });

  const recordTimestamps: (string | null)[] = [
    null,
    ...stampedBody.map((record) => record.timestamp),
  ];
  const bases: (CanonicalSourceBasis | null)[] = [null, ...bodyBases];
  return {
    records,
    bases,
    recordTimestamps,
    context: decoded.context,
    diagnostics,
    bounds,
    filters,
  };
}

function normalizeEvent(
  event: DecodedEvent,
  eventIndex: number,
  recordIndex: number,
  plan: EventPlan,
  diagnostics: Diagnostic[],
  bounds: ResolvedNormalizationBounds,
  filters: ResolvedNormalizationFilters,
  partial: boolean,
): UnstampedBodyRecord | undefined {
  if (event.type === "message") {
    if (!event.content.trim()) {
      return undefined;
    }
    if (
      event.role === "user" &&
      NOISE_PREFIXES.some((prefix) => event.content.trimStart().startsWith(prefix))
    ) {
      diagnostics.push({
        code: "noise_record_dropped",
        message: "Dropped a harness-noise user record.",
        recordIndex,
        ...(event.inputLine ? { inputLine: event.inputLine } : {}),
      });
      return undefined;
    }
    if (event.role === "user") {
      const record: Omit<UserRecord, "timestamp"> = {
        role: "user",
        content: event.content,
      };
      return record;
    }
    const record: Omit<AssistantMessageRecord, "timestamp"> = {
      role: "assistant",
      content: event.content,
    };
    return record;
  }

  if (event.type === "reasoning") {
    if (!event.content.trim()) {
      return undefined;
    }
    const record: Omit<ReasoningRecord, "timestamp"> = {
      role: "reasoning",
      content: event.content,
    };
    return record;
  }

  if (event.type === "tool_call") {
    const entry = plan.calls.get(eventIndex);
    const sourceId = entry?.sourceId ?? (event.id || `call_${eventIndex + 1}`);
    const finalId = entry?.finalId ?? sourceId;
    if (entry?.synthesized ?? !event.id) {
      diagnostics.push({
        code: "tool_call_id_synthesized",
        message: `Synthesized tool-call ID ${JSON.stringify(sourceId)}.`,
        recordIndex,
        ...(event.inputLine ? { inputLine: event.inputLine } : {}),
      });
    }
    if (entry?.renamed) {
      diagnostics.push({
        code: "duplicate_tool_call_id",
        message: `Renamed duplicate tool-call ID ${JSON.stringify(sourceId)} to ${JSON.stringify(finalId)}.`,
        recordIndex,
        ...(event.inputLine ? { inputLine: event.inputLine } : {}),
      });
    }

    const name = event.name || "unknown_tool";
    if (!event.name) {
      diagnostics.push({
        code: "unknown_tool_name",
        message: `Substituted ${JSON.stringify(name)} for a missing tool name.`,
        recordIndex,
        ...(event.inputLine ? { inputLine: event.inputLine } : {}),
      });
    }
    const args = shrinkArgs(
      event.args,
      bounds.toolArguments.maxCharacters,
    );
    if (args.reshaped) {
      diagnostics.push({
        code: "tool_arguments_reshaped",
        message: `Reshaped arguments for tool call ${JSON.stringify(finalId)} into a JSON object.`,
        recordIndex,
        ...(event.inputLine ? { inputLine: event.inputLine } : {}),
      });
    }
    if (args.truncated) {
      diagnostics.push({
        code: "tool_arguments_truncated",
        message: `Truncated arguments for tool call ${JSON.stringify(finalId)} to at most ${bounds.toolArguments.maxCharacters} Unicode code points.`,
        recordIndex,
        ...(event.inputLine ? { inputLine: event.inputLine } : {}),
      });
    }
    const record: Omit<AssistantToolCallRecord, "timestamp"> = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: finalId, name, args: args.args }],
    };
    return record;
  }

  const sourceId = event.callId || "";
  const entries = plan.openCalls.get(sourceId);
  const openEntry = entries?.find((entry) => !entry.consumed);
  // In partial (continuation) mode a tool result whose call is absent from this
  // chunk is kept and linked by its source call id — the call lived in an earlier
  // chunk and the worker resolves cross-chunk linkage. A duplicate (call present
  // but already consumed) is still dropped, as in strict mode.
  const crossChunk =
    !openEntry && partial && sourceId !== "" && !(entries && entries.length > 0);
  if (!openEntry && !crossChunk) {
    const duplicate = Boolean(entries && entries.length > 0);
    diagnostics.push({
      code: duplicate ? "duplicate_tool_result" : "orphan_tool_result",
      message: duplicate
        ? `Dropped a duplicate result for tool call ${JSON.stringify(sourceId)}.`
        : `Dropped a tool result without a preceding call for ${JSON.stringify(sourceId)}.`,
      recordIndex,
      ...(event.inputLine ? { inputLine: event.inputLine } : {}),
    });
    return undefined;
  }
  if (openEntry) openEntry.consumed = true;
  if (filters.toolResults === "omit") return undefined;
  const finalId = openEntry ? openEntry.finalId : sourceId;
  const resultLimit = bounds.toolResults.maxCharacters;
  const content =
    resultLimit === null
      ? event.content
      : truncateText(event.content, resultLimit, bounds.toolResults.strategy);
  if (content !== event.content) {
    diagnostics.push({
      code: "tool_result_truncated",
      message: `Truncated the result for tool call ${JSON.stringify(finalId)} to at most ${resultLimit} Unicode code points using the ${JSON.stringify(bounds.toolResults.strategy)} strategy.`,
      recordIndex,
      ...(event.inputLine ? { inputLine: event.inputLine } : {}),
    });
  }
  const record: Omit<ToolResultRecord, "timestamp"> = {
    role: "tool",
    tool_call_id: finalId,
    content,
    ...(typeof event.ok === "boolean" ? { ok: event.ok } : {}),
  };
  return record;
}

function buildMeta(
  context: SessionContext,
  modelCounts: Map<string, number>,
): MetaRecord {
  let model = context.model;
  if (!model) {
    // Highest count wins, tie-broken lexicographically so the choice does not
    // depend on transport-arrival / insertion order.
    let best: string | undefined;
    let highestCount = 0;
    for (const [candidate, count] of modelCounts) {
      if (
        count > highestCount ||
        (count === highestCount && best !== undefined && candidate < best)
      ) {
        best = candidate;
        highestCount = count;
      }
    }
    model = best;
  }
  return {
    role: "meta",
    source: context.source,
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.gitBranch ? { git_branch: context.gitBranch } : {}),
    ...(model ? { model } : {}),
  };
}

function fillTimestamps(
  count: number,
  anchors: Map<number, Date>,
  context: SessionContext,
  diagnostics: Diagnostic[],
): string[] {
  if (count === 0) return [];
  if (anchors.size === 0) {
    const baseMs = (context.createdAt ?? new Date(SYNTH_BASE_MS)).getTime();
    const stepSeconds =
      context.durationSeconds && count > 1
        ? context.durationSeconds / (count - 1)
        : SYNTH_STEP_SECONDS;
    diagnostics.push({
      code: "timestamps_synthesized",
      message: `Synthesized timestamps for ${count} normalized records.`,
      count,
    });
    return Array.from({ length: count }, (_, index) =>
      new Date(baseMs + stepSeconds * 1_000 * index).toISOString(),
    );
  }

  const output = new Array<string>(count);
  const indexes = [...anchors.keys()].sort((a, b) => a - b);
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (first === undefined || last === undefined) return output;

  const anchorMs = (index: number): number => {
    const anchor = anchors.get(index);
    if (!anchor) {
      throw new NormalizationError(
        "invalid_normalized_transcript",
        `Missing timestamp anchor at record ${index}.`,
      );
    }
    return anchor.getTime();
  };

  for (let index = 0; index < first; index += 1) {
    output[index] = new Date(anchorMs(first) - (first - index) * 1_000).toISOString();
  }
  for (let cursor = 0; cursor + 1 < indexes.length; cursor += 1) {
    const start = indexes[cursor];
    const end = indexes[cursor + 1];
    if (start === undefined || end === undefined) continue;
    output[start] = new Date(anchorMs(start)).toISOString();
    const spanMs = anchorMs(end) - anchorMs(start);
    const gap = end - start;
    for (let index = start + 1; index < end; index += 1) {
      output[index] = new Date(
        anchorMs(start) + (spanMs * (index - start)) / gap,
      ).toISOString();
    }
  }
  output[last] = new Date(anchorMs(last)).toISOString();
  for (let index = last + 1; index < count; index += 1) {
    output[index] = new Date(anchorMs(last) + (index - last) * 1_000).toISOString();
  }

  const interpolatedCount = count - anchors.size;
  if (interpolatedCount > 0) {
    diagnostics.push({
      code: "timestamps_interpolated",
      message: `Interpolated timestamps for ${interpolatedCount} normalized records.`,
      count: interpolatedCount,
    });
  }
  return output;
}

function shrinkArgs(rawInput: string, limit: number | null): ArgsResult {
  const raw = rawInput || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (!isPlainObject(parsed)) {
    const full = JSON.stringify({ _raw: raw });
    const wrapped = limit === null ? full : wrapRawArgs(raw, limit);
    return {
      args: wrapped,
      reshaped: true,
      truncated: wrapped !== full,
    };
  }
  if (limit === null || codePointLength(raw) <= limit) {
    return { args: raw, reshaped: false, truncated: false };
  }

  const legacy = shrinkObjectArgsLegacy(parsed, limit);
  if (codePointLength(legacy) <= limit) {
    return { args: legacy, reshaped: false, truncated: true };
  }

  // The legacy loop can repeat forever, or stop above the cap when every
  // string reaches its preferred floor. Restart from the original object and
  // continue with a strictly-decreasing fallback in those cases only.
  const fresh = JSON.parse(raw) as Record<string, unknown>;
  const serialized = shrinkObjectArgsSafely(fresh, limit);
  if (codePointLength(serialized) > limit) {
    return {
      args: wrapRawArgs(raw, limit),
      reshaped: true,
      truncated: true,
    };
  }
  return { args: serialized, reshaped: false, truncated: true };
}

function shrinkObjectArgsLegacy(
  parsed: Record<string, unknown>,
  limit: number,
): string {
  const leaves: StringLeaf[] = [];
  collectStringLeaves(parsed, leaves);
  let serialized = JSON.stringify(parsed);
  const seen = new Set<string>();
  while (codePointLength(serialized) > limit && leaves.length > 0) {
    if (seen.has(serialized)) break;
    seen.add(serialized);
    let largest = leaves[0];
    if (!largest) break;
    for (const leaf of leaves) {
      if (codePointLength(leafValue(leaf)) > codePointLength(leafValue(largest))) {
        largest = leaf;
      }
    }
    const value = leafValue(largest);
    const valueLength = codePointLength(value);
    if (valueLength <= ARGS_LEAF_FLOOR) break;
    const keep = Math.max(ARGS_LEAF_FLOOR, Math.floor(valueLength / 2));
    setLeafValue(
      largest,
      sliceCodePoints(value, 0, keep) + truncationMarker(valueLength - keep),
    );
    serialized = JSON.stringify(parsed);
  }
  return serialized;
}

function shrinkObjectArgsSafely(
  parsed: Record<string, unknown>,
  limit: number,
): string {
  const leaves: StringLeaf[] = [];
  collectStringLeaves(parsed, leaves);
  let serialized = JSON.stringify(parsed);
  while (codePointLength(serialized) > limit && leaves.length > 0) {
    let largest = leaves.find((leaf) => leaf.currentLength > 0);
    if (!largest) break;
    for (const leaf of leaves) {
      if (leaf.currentLength > largest.currentLength) largest = leaf;
    }
    const previousLength = codePointLength(serialized);
    const overflow = previousLength - limit;
    let candidate = "";
    let nextKeep = 0;
    if (largest.keep > 0) {
      const preferredFloor = largest.keep > ARGS_LEAF_FLOOR ? ARGS_LEAF_FLOOR : 0;
      const markerBudget = codePointLength(
        truncationMarker(codePointLength(largest.original)),
      );
      nextKeep = Math.max(
        preferredFloor,
        Math.min(
          Math.floor(largest.keep / 2),
          largest.keep - overflow - markerBudget - 1,
        ),
      );
      nextKeep = Math.max(0, Math.min(nextKeep, largest.keep - 1));
      candidate =
        sliceCodePoints(largest.original, 0, nextKeep) +
        truncationMarker(codePointLength(largest.original) - nextKeep);
      if (codePointLength(candidate) >= largest.currentLength) {
        candidate = "";
        nextKeep = 0;
      }
    }
    setLeafValue(largest, candidate);
    largest.keep = nextKeep;
    largest.currentLength = codePointLength(candidate);
    serialized = JSON.stringify(parsed);
    if (codePointLength(serialized) >= previousLength && candidate) {
      setLeafValue(largest, "");
      largest.keep = 0;
      largest.currentLength = 0;
      serialized = JSON.stringify(parsed);
    }
  }
  return serialized;
}

function collectStringLeaves(
  value: unknown,
  leaves: StringLeaf[],
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === "string") {
        leaves.push({
          parent: value,
          key: index,
          original: child,
          keep: codePointLength(child),
          currentLength: codePointLength(child),
        });
      } else if (child !== null && typeof child === "object") {
        collectStringLeaves(child, leaves);
      }
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      leaves.push({
        parent: value,
        key,
        original: child,
        keep: codePointLength(child),
        currentLength: codePointLength(child),
      });
    } else if (child !== null && typeof child === "object") {
      collectStringLeaves(child, leaves);
    }
  }
}

function setLeafValue(leaf: StringLeaf, value: string): void {
  if (Array.isArray(leaf.parent)) leaf.parent[leaf.key as number] = value;
  else leaf.parent[leaf.key as string] = value;
}

function leafValue(leaf: StringLeaf): string {
  const value = Array.isArray(leaf.parent)
    ? leaf.parent[leaf.key as number]
    : leaf.parent[leaf.key as string];
  return typeof value === "string" ? value : "";
}

function wrapRawArgs(raw: string, limit: number): string {
  const full = JSON.stringify({ _raw: raw });
  if (codePointLength(full) <= limit) return full;

  let low = 0;
  const rawLength = codePointLength(raw);
  let high = Math.min(rawLength, limit);
  let best = "{}";
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      _raw: sliceCodePoints(raw, 0, keep) + truncationMarker(rawLength - keep),
    });
    if (codePointLength(candidate) <= limit) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncateText(
  text: string,
  limit: number,
  strategy: "head" | "head-tail",
): string {
  const textLength = codePointLength(text);
  if (textLength <= limit) return text;

  let low = 0;
  let high = Math.min(textLength - 1, limit);
  let keep = -1;
  let marker = "";
  while (low <= high) {
    const candidateKeep = Math.floor((low + high) / 2);
    const candidateMarker = truncationMarker(
      textLength - candidateKeep,
    );
    if (candidateKeep + codePointLength(candidateMarker) <= limit) {
      keep = candidateKeep;
      marker = candidateMarker;
      low = candidateKeep + 1;
    } else {
      high = candidateKeep - 1;
    }
  }

  // Extremely small user-supplied limits cannot fit the descriptive marker.
  if (keep < 0) {
    marker = sliceCodePoints("…", 0, limit);
    keep = limit - codePointLength(marker);
  }

  if (strategy === "head") {
    return sliceCodePoints(text, 0, keep) + marker;
  }
  const headLength = Math.ceil(keep / 2);
  const tailLength = keep - headLength;
  return (
    sliceCodePoints(text, 0, headLength) +
    marker +
    (tailLength > 0
      ? sliceCodePoints(text, textLength - tailLength, textLength)
      : "")
  );
}

function truncationMarker(remaining: number): string {
  return `\n… [truncated, ${remaining} more chars]`;
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _character of text) length += 1;
  return length;
}

function sliceCodePoints(text: string, start: number, end?: number): string {
  const stop = end ?? Number.POSITIVE_INFINITY;
  let result = "";
  let index = 0;
  for (const character of text) {
    if (index >= stop) break;
    if (index >= start) result += character;
    index += 1;
  }
  return result;
}
