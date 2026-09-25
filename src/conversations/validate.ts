import { isObject } from "../adapters/shared.js";
import { NormalizationError } from "../types.js";
import type { Conversation } from "./types.js";

const META_KEYS = new Set(["role", "source", "channel", "channel_name", "participants"]);
const MESSAGE_KEYS = new Set(["id", "speaker", "content", "timestamp", "reactions"]);
const POST_KEYS = new Set([...MESSAGE_KEYS, "replies"]);
const FRAGMENT_KEYS = new Set(["id", "missing_root", "replies"]);
const PARTICIPANT_KEYS = new Set(["id", "bot"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** One channel: shared context, then top-level posts with replies nested once. */
export function validateConversation(value: unknown): asserts value is Conversation {
  if (!Array.isArray(value) || value.length < 1) {
    fail("Conversation requires leading metadata.");
  }
  const meta = value[0];
  if (!isObject(meta) || meta.role !== "meta" || !nonempty(meta.source) || !nonempty(meta.channel)) {
    fail("Conversation requires leading meta with source and channel.");
  }
  exactKeys(meta, META_KEYS);
  if ("channel_name" in meta && !nonempty(meta.channel_name)) {
    fail("Channel name must be non-empty when present.");
  }
  const labels = validateParticipants(meta.participants);
  const ids = new Set<string>();
  for (const record of value.slice(1)) {
    if (!isObject(record) || "role" in record) {
      fail("Conversation body must contain only posts, not agent roles.");
    }
    if ("missing_root" in record) {
      exactKeys(record, FRAGMENT_KEYS);
      if (record.missing_root !== true) fail("Thread fragments must set missing_root to true.");
      if (!("replies" in record)) fail("Thread fragments require replies.");
      claimId(record.id, ids);
    } else {
      exactKeys(record, POST_KEYS);
      validateMessage(record, ids, labels);
    }
    if ("replies" in record) {
      if (!Array.isArray(record.replies) || record.replies.length === 0) {
        fail("Replies must be a non-empty array; omit the field for posts without replies.");
      }
      for (const reply of record.replies) {
        if (!isObject(reply)) fail("Replies must be objects.");
        exactKeys(reply, MESSAGE_KEYS);
        validateMessage(reply, ids, labels);
      }
    }
  }
}

function validateParticipants(value: unknown): Set<string> {
  if (!isObject(value)) fail("Conversation meta requires a participants object.");
  const ids = new Set<string>();
  for (const [label, participant] of Object.entries(value)) {
    if (!nonempty(label)) fail("Participant labels must be non-empty.");
    if (!isObject(participant) || !nonempty(participant.id)) fail("Participants must contain a non-empty id.");
    exactKeys(participant, PARTICIPANT_KEYS);
    if ("bot" in participant && participant.bot !== true) fail("Participant bot flag must be true when present.");
    if (ids.has(participant.id)) fail("Participant IDs must be unique.");
    ids.add(participant.id);
  }
  return new Set(Object.keys(value));
}

function validateMessage(record: Record<string, unknown>, ids: Set<string>, labels: Set<string>): void {
  claimId(record.id, ids);
  if (typeof record.speaker !== "string" || !labels.has(record.speaker)) {
    fail("Message speaker must be a participant label.");
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

function validateReactions(value: unknown): void {
  if (!isObject(value)) fail("Reactions must map reaction names to counts.");
  for (const [name, count] of Object.entries(value)) {
    if (!nonempty(name)) fail("Reaction names must be non-empty.");
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      fail("Reaction count must be a non-negative safe integer.");
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
