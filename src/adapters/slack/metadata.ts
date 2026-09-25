import type { ConversationParticipant } from "../../conversations/types.js";
import { NormalizationError } from "../../types.js";
import { isObject } from "../shared.js";

export interface DirectoryEntry {
  name?: string;
  bot: boolean;
}

/** User mentions, optionally with a legacy inline label: `<@U123>` or `<@U123|alice>`. */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;

/** Accept raw users.list rows, including rows loaded from a mirror's users.jsonl. */
export function buildDirectory(value: unknown): Map<string, DirectoryEntry> {
  const directory = new Map<string, DirectoryEntry>();
  if (value === undefined) return directory;
  if (!Array.isArray(value)) throw invalid("Slack users must be an array.");
  for (const user of value) {
    if (!isObject(user) || typeof user.id !== "string" || !user.id.trim()) {
      throw invalid("Slack users require a source user id.");
    }
    const name = profileName(user.profile) ?? label(user.real_name) ?? label(user.name);
    const existing = directory.get(user.id);
    if (existing?.name !== undefined && name !== undefined && existing.name !== name) {
      throw invalid("Conflicting names for a Slack user; supply one authoritative user snapshot.");
    }
    const merged = name ?? existing?.name;
    directory.set(user.id, {
      ...(merged === undefined ? {} : { name: merged }),
      bot: user.is_bot === true || existing?.bot === true,
    });
  }
  return directory;
}

/** The sender's name as carried on the message itself, if any. */
export function inlineName(raw: Record<string, unknown>): string | undefined {
  const name = profileName(raw.user_profile);
  if (name || typeof raw.bot_id !== "string" || !raw.bot_id.trim()) return name;
  return (isObject(raw.bot_profile) ? label(raw.bot_profile.name) : undefined) ?? label(raw.username);
}

export function isBotMessage(raw: Record<string, unknown>): boolean {
  return raw.subtype === "bot_message" || isObject(raw.bot_profile) || nonemptyText(raw.user) === undefined;
}

/** Reaction names mapped to Slack's reported counts; who reacted is not kept. */
export function readReactions(value: unknown): Record<string, number> {
  if (!Array.isArray(value)) throw invalid("Slack reactions must be an array.");
  const counts = new Map<string, number>();
  for (const reaction of value) {
    if (!isObject(reaction)) throw invalid("Slack reactions must be objects.");
    const name = nonemptyText(reaction.name);
    if (!name || counts.has(name)) throw invalid("Slack reaction names must be non-empty and unique per message.");
    const count = reaction.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw invalid("Slack reaction count must be a non-negative safe integer.");
    }
    counts.set(name, count);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b)));
}

/** `[file: name]` placeholders, so a reference like "see attached" keeps its object. */
export function filePlaceholders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((file) => {
    const name = isObject(file) ? label(file.name) ?? label(file.title) : undefined;
    return name ? `[file: ${name}]` : "[file]";
  });
}

/** User IDs mentioned in text, with any legacy inline label as a naming fallback. */
export function mentionedUsers(text: string): [string, string | undefined][] {
  return [...text.matchAll(MENTION)].map((match) => [match[1] as string, label(match[2])]);
}

export function resolveMentions(text: string, labels: Map<string, string>): string {
  return text.replace(MENTION, (mention, id: string) => {
    const name = labels.get(id);
    return name === undefined ? mention : `@${name}`;
  });
}

/**
 * One unique label per participant: its display name, or its ID when unnamed.
 * IDs are visited in sorted order so the same people get the same labels regardless of input order.
 */
export function assignLabels(
  names: Map<string, string | undefined>,
  bots: Set<string>,
): { labels: Map<string, string>; participants: Record<string, ConversationParticipant> } {
  const labels = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...names.keys()].sort(compareText)) {
    const base = names.get(id) ?? id;
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base} (${n})`;
    used.add(candidate);
    labels.set(id, candidate);
  }
  const participants = Object.fromEntries([...labels]
    .sort(([, a], [, b]) => compareText(a, b))
    .map(([id, name]) => [name, bots.has(id) ? { id, bot: true as const } : { id }]));
  return { labels, participants };
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileName(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return label(value.display_name) ?? label(value.real_name);
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function nonemptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function invalid(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
