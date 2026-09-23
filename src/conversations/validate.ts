import { isObject } from "../adapters/shared.js";
import { NormalizationError } from "../types.js";
import type { Conversation } from "./types.js";

const META_KEYS = new Set(["role", "source", "conversation_id", "source_metadata"]);
const MESSAGE_KEYS = new Set(["role", "id", "speaker", "content", "timestamp"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Each conversation includes shared context and at least one attributed message. */
export function validateConversation(value: unknown): asserts value is Conversation {
  if (!Array.isArray(value) || value.length < 2) {
    fail("Conversation requires metadata and at least one message.");
  }
  const meta = value[0];
  if (!isObject(meta) || meta.role !== "meta" ||
      !nonempty(meta.source) || !nonempty(meta.conversation_id)) {
    fail("Conversation requires leading meta with source and conversation_id.");
  }
  exactKeys(meta, META_KEYS);
  if ("source_metadata" in meta &&
      (!isObject(meta.source_metadata) ||
       !Object.values(meta.source_metadata).every((field) => typeof field === "string"))) {
    fail("source_metadata must be an object with string values.");
  }
  const ids = new Set<string>();
  for (const record of value.slice(1)) {
    if (!isObject(record) || record.role !== "message") {
      fail("Conversation body must contain only attributed messages, not agent roles.");
    }
    exactKeys(record, MESSAGE_KEYS);
    if (!nonempty(record.id) || ids.has(record.id)) {
      fail("Message IDs must be non-empty and unique within the conversation.");
    }
    ids.add(record.id);
    if (!isObject(record.speaker) || !nonempty(record.speaker.id) ||
        Object.keys(record.speaker).length !== 1) {
      fail("Message speaker must contain a non-empty id.");
    }
    if (!nonempty(record.content)) fail("Message content must be non-empty text.");
    if (typeof record.timestamp !== "string" || !ISO_TIMESTAMP.test(record.timestamp) ||
        Number.isNaN(Date.parse(record.timestamp))) {
      fail("Message timestamp must be a valid ISO timestamp.");
    }
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(record: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`Unexpected conversation field: ${key}`);
  }
}

function fail(message: string): never {
  throw new NormalizationError("invalid_input", message);
}
