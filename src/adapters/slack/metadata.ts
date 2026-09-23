import type { ConversationReaction, ConversationSpeaker } from "../../conversations/types.js";
import { validateReactions } from "../../conversations/validate.js";
import { NormalizationError } from "../../types.js";
import { isObject } from "../shared.js";

/** Accept raw users.list rows, including rows loaded from a mirror's users.jsonl. */
export function buildUserNames(value: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (value === undefined) return names;
  if (!Array.isArray(value)) throw invalid("Slack users must be an array.");
  for (const user of value) {
    if (!isObject(user) || typeof user.id !== "string" || !user.id.trim()) {
      throw invalid("Slack users require a source user id.");
    }
    const name = profileName(user.profile) ?? label(user.real_name) ?? label(user.name);
    if (name === undefined) continue;
    if (names.has(user.id) && names.get(user.id) !== name) {
      throw invalid("Conflicting names for a Slack user; supply one authoritative user snapshot.");
    }
    names.set(user.id, name);
  }
  return names;
}

export function resolveSpeaker(
  raw: Record<string, unknown>,
  id: string,
  names: Map<string, string>,
): ConversationSpeaker {
  let name = profileName(raw.user_profile) ?? names.get(id);
  if (!name && typeof raw.bot_id === "string" && raw.bot_id.trim()) {
    if (isObject(raw.bot_profile)) name = label(raw.bot_profile.name);
    name ??= label(raw.username);
  }
  return { id, ...(name ? { name } : {}) };
}

export function readReactions(value: unknown, names: Map<string, string>): ConversationReaction[] {
  if (!Array.isArray(value)) throw invalid("Slack reactions must be an array.");
  const reactions: unknown = value.map((reaction) => {
    if (!isObject(reaction)) throw invalid("Slack reactions must be objects.");
    if (!Array.isArray(reaction.users)) throw invalid("Slack reaction users must be an array of IDs.");
    // These arrays describe sets, not arrival order. Canonicalize before deduplication.
    const users = reaction.users.map((id) => {
      if (typeof id !== "string" || !id.trim()) throw invalid("Slack reaction users must be non-empty IDs.");
      return id;
    }).sort().map((id) => {
      const name = names.get(id);
      return { id, ...(name ? { name } : {}) };
    });
    return { name: reaction.name, count: reaction.count, users };
  });
  validateReactions(reactions);
  return [...reactions].sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}

function profileName(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return label(value.display_name) ?? label(value.real_name);
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function invalid(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
