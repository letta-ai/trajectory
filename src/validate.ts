import type { NormalizedRecord } from "./types.js";
import { NormalizationError } from "./types.js";

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

const META_KEYS = new Set(["role", "source", "cwd", "git_branch", "model"]);
const CONTENT_KEYS = new Set(["role", "content", "timestamp"]);
const ASSISTANT_TOOL_KEYS = new Set(["role", "content", "timestamp", "tool_calls"]);
const TOOL_RESULT_KEYS = new Set(["role", "tool_call_id", "content", "timestamp"]);
const TOOL_CALL_KEYS = new Set(["id", "name", "args"]);

export function validateTranscript(value: unknown): asserts value is NormalizedRecord[] {
  if (!Array.isArray(value) || value.length === 0) fail("Transcript must be a non-empty array.");

  // Collect every tool-call id first so a tool result may reference a call that
  // appears later in the transcript (order-independent linkage).
  const allCallIds = collectCallIds(value);
  const callIds = new Set<string>();
  const roles = new Set<string>();
  let metaSeen = false;

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
      continue;
    }

    validateTimestamp(record.timestamp, index);
    if (record.role === "user" || record.role === "reasoning") {
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
      if (typeof record.tool_call_id !== "string" || !allCallIds.has(record.tool_call_id)) {
        fail(`Record ${index}: tool result must reference a tool call.`);
      }
      if (typeof record.content !== "string") {
        fail(`Record ${index}: tool content must be a string.`);
      }
      continue;
    }

    fail(`Record ${index}: unknown role ${JSON.stringify(record.role)}.`);
  }

  if (!roles.has("user")) fail("Transcript must contain at least one user record.");
  if (!roles.has("assistant")) fail("Transcript must contain at least one assistant record.");
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
