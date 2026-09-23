import { isObject } from "../adapters/shared.js";
import { NormalizationError } from "../types.js";
import type { Conversation, ConversationReaction } from "./types.js";

const META_KEYS = new Set(["role", "source", "conversation_id", "source_metadata"]);
const MESSAGE_KEYS = new Set(["role", "id", "speaker", "content", "timestamp", "metadata"]);
const SPEAKER_KEYS = new Set(["id", "name"]);
const METADATA_KEYS = new Set(["reactions"]);
const REACTION_KEYS = new Set(["name", "count", "users"]);
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
    if (!isObject(record.speaker) || !nonempty(record.speaker.id)) {
      fail("Message speaker must contain a non-empty id.");
    }
    exactKeys(record.speaker, SPEAKER_KEYS);
    if ("name" in record.speaker && !nonempty(record.speaker.name)) {
      fail("Speaker name must be non-empty when present.");
    }
    if ("metadata" in record) {
      if (!isObject(record.metadata)) fail("Message metadata must be an object.");
      exactKeys(record.metadata, METADATA_KEYS);
      if ("reactions" in record.metadata) validateReactions(record.metadata.reactions);
    }
    if (!nonempty(record.content)) fail("Message content must be non-empty text.");
    if (typeof record.timestamp !== "string" || !ISO_TIMESTAMP.test(record.timestamp) ||
        Number.isNaN(Date.parse(record.timestamp))) {
      fail("Message timestamp must be a valid ISO timestamp.");
    }
  }
}

/** Also used by source adapters before normalizing reaction ordering. */
export function validateReactions(value: unknown): asserts value is ConversationReaction[] {
  if (!Array.isArray(value)) fail("Reactions must be an array.");
  const names = new Set<string>();
  for (const reaction of value) {
    if (!isObject(reaction)) fail("Reaction must be an object.");
    exactKeys(reaction, REACTION_KEYS);
    if (!nonempty(reaction.name) || names.has(reaction.name)) {
      fail("Reaction names must be non-empty and unique per message.");
    }
    names.add(reaction.name);
    if (typeof reaction.count !== "number" || !Number.isSafeInteger(reaction.count) || reaction.count < 0) {
      fail("Reaction count must be a non-negative safe integer.");
    }
    if (!Array.isArray(reaction.users) || !reaction.users.every(nonempty) ||
        new Set(reaction.users).size !== reaction.users.length || reaction.users.length > reaction.count) {
      fail("Reaction users must be unique IDs and cannot exceed the source-reported count.");
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
