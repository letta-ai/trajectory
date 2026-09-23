import { isObject } from "../adapters/shared.js";
import { NormalizationError } from "../types.js";
import type { Conversation, ConversationReaction } from "./types.js";

const META_KEYS = new Set(["role", "source", "channel"]);
const MESSAGE_KEYS = new Set(["id", "speaker", "content", "timestamp", "reactions"]);
const POST_KEYS = new Set([...MESSAGE_KEYS, "replies"]);
const FRAGMENT_KEYS = new Set(["id", "replies"]);
const SPEAKER_KEYS = new Set(["id", "name"]);
const REACTION_KEYS = new Set(["name", "count", "users"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** One channel: shared context, then top-level posts with replies nested once. */
export function validateConversation(value: unknown): asserts value is Conversation {
  if (!Array.isArray(value) || value.length < 2) {
    fail("Conversation requires metadata and at least one post.");
  }
  const meta = value[0];
  if (!isObject(meta) || meta.role !== "meta" || !nonempty(meta.source) || !nonempty(meta.channel)) {
    fail("Conversation requires leading meta with source and channel.");
  }
  exactKeys(meta, META_KEYS);
  const ids = new Set<string>();
  for (const record of value.slice(1)) {
    if (!isObject(record) || "role" in record) {
      fail("Conversation body must contain only posts, not agent roles.");
    }
    if (!("speaker" in record) && "replies" in record) {
      exactKeys(record, FRAGMENT_KEYS);
      claimId(record.id, ids);
    } else {
      exactKeys(record, POST_KEYS);
      validateMessage(record, ids);
    }
    if ("replies" in record) {
      if (!Array.isArray(record.replies) || record.replies.length === 0) {
        fail("Replies must be a non-empty array; omit the field for posts without replies.");
      }
      for (const reply of record.replies) {
        if (!isObject(reply)) fail("Replies must be objects.");
        exactKeys(reply, MESSAGE_KEYS);
        validateMessage(reply, ids);
      }
    }
  }
}

function validateMessage(record: Record<string, unknown>, ids: Set<string>): void {
  claimId(record.id, ids);
  if (!isObject(record.speaker) || !nonempty(record.speaker.id)) {
    fail("Message speaker must contain a non-empty id.");
  }
  exactKeys(record.speaker, SPEAKER_KEYS);
  if ("name" in record.speaker && !nonempty(record.speaker.name)) {
    fail("Speaker name must be non-empty when present.");
  }
  if ("reactions" in record) validateReactions(record.reactions);
  if (!nonempty(record.content)) fail("Message content must be non-empty text.");
  if (typeof record.timestamp !== "string" || !ISO_TIMESTAMP.test(record.timestamp) ||
      Number.isNaN(Date.parse(record.timestamp))) {
    fail("Message timestamp must be a valid ISO timestamp.");
  }
}

function claimId(id: unknown, ids: Set<string>): void {
  if (!nonempty(id) || ids.has(id)) {
    fail("Message IDs must be non-empty and unique within the conversation.");
  }
  ids.add(id);
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
