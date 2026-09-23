import type { NormalizedRecord } from "./types.js";
import { NormalizationError } from "./types.js";

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

const META_KEYS = new Set(["role", "source", "cwd", "git_branch", "model", "conversation_id", "source_metadata"]);
const CONTENT_KEYS = new Set(["role", "content", "timestamp"]);
const ASSISTANT_TOOL_KEYS = new Set(["role", "content", "timestamp", "tool_calls"]);
const TOOL_RESULT_KEYS = new Set(["role", "tool_call_id", "content", "ok", "timestamp"]);
const TOOL_CALL_KEYS = new Set(["id", "name", "args"]);
const MESSAGE_KEYS = new Set(["role", "id", "speaker", "content", "timestamp"]);
const SPEAKER_KEYS = new Set(["id"]);

/**
 * Options for {@link validateTranscript}.
 *
 * `partial` relaxes the whole-conversation invariants for a transcript fragment:
 * it no longer requires a user and an assistant turn, and a tool result may
 * reference a tool call that lived outside the fragment (not present here).
 */
export interface ValidateOptions {
  partial?: boolean;
}

export function validateTranscript(
  value: unknown,
  options?: ValidateOptions,
): asserts value is NormalizedRecord[] {
  const partial = options?.partial ?? false;
  if (!Array.isArray(value) || value.length === 0) fail("Transcript must be a non-empty array.");

  // Collect every tool-call id first so a tool result may reference a call that
  // appears later in the transcript (order-independent linkage).
  const allCallIds = collectCallIds(value);
  const callIds = new Set<string>();
  const roles = new Set<string>();
  let metaSeen = false;
  const attributed = value.some((record) => isObject(record) && record.role === "message");
  const messageIds = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!isObject(record) || typeof record.role !== "string") {
      fail(`Record ${index} must be an object with a role.`);
    }
    roles.add(record.role);

    if (record.role === "meta") {
      if (index !== 0 || metaSeen) fail(`Record ${index}: meta must appear once at index 0.`);
      metaSeen = true;
      exactKeys(record, META_KEYS, index);
      if (typeof record.source !== "string" || !record.source) {
        fail(`Record ${index}: meta.source must be a non-empty string.`);
      }
      optionalString(record, "cwd", index);
      optionalString(record, "git_branch", index);
      optionalString(record, "model", index);
      if ("conversation_id" in record &&
          (typeof record.conversation_id !== "string" || !record.conversation_id.trim())) {
        fail(`Record ${index}: conversation_id must be a non-empty string.`);
      }
      if ("source_metadata" in record &&
          (!isObject(record.source_metadata) ||
           !Object.values(record.source_metadata).every((field) => typeof field === "string"))) {
        fail(`Record ${index}: source_metadata must be an object with string values.`);
      }
      continue;
    }

    validateTimestamp(record.timestamp, index);
    if (attributed && record.role !== "message") {
      fail(`Record ${index}: attributed conversations cannot mix message and agent roles.`);
    }
    if (record.role === "message") {
      exactKeys(record, MESSAGE_KEYS, index);
      if (typeof record.id !== "string" || !record.id.trim() || messageIds.has(record.id)) {
        fail(`Record ${index}: message.id must be non-empty and unique within the conversation.`);
      }
      messageIds.add(record.id);
      if (typeof record.content !== "string" || !record.content.trim()) {
        fail(`Record ${index}: message.content must be a non-empty string.`);
      }
      if (!isObject(record.speaker)) {
        fail(`Record ${index}: invalid message speaker.`);
      }
      exactKeys(record.speaker, SPEAKER_KEYS, index, "speaker");
      if (typeof record.speaker.id !== "string" || !record.speaker.id.trim()) {
        fail(`Record ${index}: speaker.id must be a non-empty string.`);
      }
      continue;
    }
    if (
      record.role === "system" ||
      record.role === "observation" ||
      record.role === "user" ||
      record.role === "reasoning"
    ) {
      exactKeys(record, CONTENT_KEYS, index);
      if (typeof record.content !== "string") {
        fail(`Record ${index}: ${record.role} content must be a string.`);
      }
      continue;
    }

    if (record.role === "assistant") {
      if ("tool_calls" in record) {
        exactKeys(record, ASSISTANT_TOOL_KEYS, index);
        if (record.content !== null) {
          fail(`Record ${index}: assistant tool-call content must be null.`);
        }
        if (!Array.isArray(record.tool_calls) || record.tool_calls.length === 0) {
          fail(`Record ${index}: assistant tool_calls must be a non-empty array.`);
        }
        for (const call of record.tool_calls) validateToolCall(call, index, callIds);
      } else {
        exactKeys(record, CONTENT_KEYS, index);
        if (typeof record.content !== "string" || !record.content) {
          fail(`Record ${index}: assistant content must be a non-empty string.`);
        }
      }
      continue;
    }

    if (record.role === "tool") {
      exactKeys(record, TOOL_RESULT_KEYS, index);
      if (
        typeof record.tool_call_id !== "string" ||
        !record.tool_call_id ||
        (!partial && !allCallIds.has(record.tool_call_id))
      ) {
        fail(`Record ${index}: tool result must reference a tool call.`);
      }
      if (typeof record.content !== "string") {
        fail(`Record ${index}: tool content must be a string.`);
      }
      if ("ok" in record && typeof record.ok !== "boolean") {
        fail(`Record ${index}: tool ok must be boolean when present.`);
      }
      continue;
    }

    fail(`Record ${index}: unknown role ${JSON.stringify(record.role)}.`);
  }

  if (!partial) {
    if (attributed) {
      const meta = value[0];
      if (!isObject(meta) || meta.role !== "meta" || typeof meta.conversation_id !== "string") {
        fail("Attributed conversations require leading meta with a conversation_id.");
      }
      return;
    }
    if (!roles.has("user")) fail("Transcript must contain at least one user record.");
    if (!roles.has("assistant")) {
      fail("Transcript must contain at least one assistant record.");
    }
  }
}

function collectCallIds(records: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (!isObject(record) || record.role !== "assistant") continue;
    if (!Array.isArray(record.tool_calls)) continue;
    for (const call of record.tool_calls) {
      if (isObject(call) && typeof call.id === "string" && call.id) {
        ids.add(call.id);
      }
    }
  }
  return ids;
}

function validateToolCall(call: unknown, recordIndex: number, callIds: Set<string>): void {
  if (!isObject(call)) fail(`Record ${recordIndex}: tool call must be an object.`);
  exactKeys(call, TOOL_CALL_KEYS, recordIndex, "tool call");
  if (typeof call.id !== "string" || !call.id) {
    fail(`Record ${recordIndex}: tool-call ID must be a non-empty string.`);
  }
  if (callIds.has(call.id)) fail(`Record ${recordIndex}: duplicate tool-call ID ${call.id}.`);
  if (typeof call.name !== "string" || !call.name) {
    fail(`Record ${recordIndex}: tool-call name must be a non-empty string.`);
  }
  if (typeof call.args !== "string") {
    fail(`Record ${recordIndex}: tool-call args must be a string.`);
  }
  let args: unknown;
  try {
    args = JSON.parse(call.args);
  } catch {
    fail(`Record ${recordIndex}: tool-call args must contain valid JSON.`);
  }
  if (!isObject(args)) {
    fail(`Record ${recordIndex}: tool-call args must encode a JSON object.`);
  }
  callIds.add(call.id);
}

function validateTimestamp(value: unknown, recordIndex: number): void {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    fail(`Record ${recordIndex}: timestamp must be an ISO-8601 instant.`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  recordIndex: number,
  label = "record",
): void {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) fail(`Record ${recordIndex}: unexpected ${label} field ${JSON.stringify(extra)}.`);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  recordIndex: number,
): void {
  if (key in value && typeof value[key] !== "string") {
    fail(`Record ${recordIndex}: ${key} must be a string when present.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new NormalizationError("invalid_normalized_transcript", message);
}
