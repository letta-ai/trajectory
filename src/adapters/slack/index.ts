import type {
  ConversationDiagnostic,
  ConversationMessage,
  ConversationMetaRecord,
  ConversationPost,
  ConversationThreadFragment,
  NormalizeConversationResult,
} from "../../conversations/types.js";
import { NormalizationError } from "../../types.js";
import { isObject, nonemptyString } from "../shared.js";
import { compareSlackTimestamps, parseSlackTimestamp } from "./timestamp.js";
import {
  assignLabels,
  buildDirectory,
  compareText,
  filePlaceholders,
  inlineName,
  isBotMessage,
  mentionedUsers,
  readReactions,
  resolveMentions,
} from "./metadata.js";

const MESSAGE_SUBTYPES = new Set([
  "bot_message",
  "thread_broadcast",
  "file_share",
  "me_message",
]);

export interface SlackChannelInput {
  /** JSONL rows, a JSON array, or a `conversations.history` response. */
  transcript: string;
  channel: string;
  channelName?: string;
  users?: unknown[];
}

/** One copy of a message as it appeared in the dump, before duplicate copies are reconciled. */
interface Snapshot {
  ts: string;
  thread: string;
  speaker: string;
  content: string;
  timestamp: string;
  reactions?: Record<string, number>;
  edited?: string;
}

/** One channel's raw messages become one conversation: posts in order, replies nested once. */
export function normalizeSlackChannel(input: SlackChannelInput): NormalizeConversationResult {
  const channel = nonemptyString(input.channel);
  if (!channel) throw invalid("Slack input requires the channel the messages were fetched from.");
  if (input.channelName !== undefined && !input.channelName.trim()) {
    throw invalid("Slack channel name must be non-empty when supplied.");
  }
  const directory = buildDirectory(input.users);
  const diagnostics: ConversationDiagnostic[] = [];
  const copies = new Map<string, Snapshot[]>();
  const inlineNames = new Map<string, { ts: string; name: string }>();
  const bots = new Set([...directory].filter(([, entry]) => entry.bot).map(([id]) => id));
  for (const raw of parseSlackMessages(input.transcript)) {
    if (!isObject(raw)) throw invalid("Slack messages must be objects.");
    if (
      raw.type !== "message" ||
      (raw.subtype !== undefined && !MESSAGE_SUBTYPES.has(String(raw.subtype)))
    ) {
      diagnostics.push({
        code: "slack_message_dropped",
        message: "Skipped an unsupported Slack event or message subtype.",
      });
      continue;
    }
    const time = parseSlackTimestamp(raw.ts);
    const thread = parseSlackTimestamp(raw.thread_ts ?? raw.ts);
    if (!time || !thread) throw invalid("Invalid Slack message timestamp.");
    if (compareSlackTimestamps(time.ts, thread.ts) < 0) {
      throw invalid("Slack reply precedes its thread root.");
    }
    if (raw.channel !== undefined && raw.channel !== channel) {
      throw invalid("Slack message channel disagrees with the supplied channel.");
    }
    const speaker = nonemptyString(raw.user) ?? nonemptyString(raw.bot_id);
    if (!speaker) throw invalid("Slack message has no source speaker identity.");
    // The most recent name carried on a message wins, independent of input order.
    const name = inlineName(raw);
    const previous = inlineNames.get(speaker);
    if (name && (!previous || compareSlackTimestamps(time.ts, previous.ts) > 0 ||
        (time.ts === previous.ts && compareText(name, previous.name) > 0))) {
      inlineNames.set(speaker, { ts: time.ts, name });
    }
    if (isBotMessage(raw)) bots.add(speaker);
    // Text is the canonical message body. Blocks and unfurls usually duplicate it.
    // Do not interpret relayed '*User*'/'*Assistant*' labels as source identities.
    const text = typeof raw.text === "string" && raw.text.trim() ? raw.text : undefined;
    const content = [...(text ? [text] : []), ...filePlaceholders(raw.files)].join("\n");
    if (!content) {
      diagnostics.push({
        code: "slack_message_dropped",
        message: "Skipped a Slack post without text or files (blocks are not extracted).",
      });
      continue;
    }
    const edited = isObject(raw.edited) ? parseSlackTimestamp(raw.edited.ts)?.ts : undefined;
    const snapshot: Snapshot = {
      ts: time.ts,
      thread: thread.ts,
      speaker,
      content,
      timestamp: time.date.toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...("reactions" in raw ? { reactions: readReactions(raw.reactions) } : {}),
      ...(edited ? { edited } : {}),
    };
    const existing = copies.get(time.ts);
    if (existing) existing.push(snapshot);
    else copies.set(time.ts, [snapshot]);
  }

  const messages = new Map<string, Snapshot>();
  for (const ts of [...copies.keys()].sort(compareSlackTimestamps)) {
    messages.set(ts, reconcile(copies.get(ts) ?? [], diagnostics));
  }

  const names = new Map<string, string | undefined>();
  for (const message of messages.values()) {
    names.set(message.speaker, directory.get(message.speaker)?.name ?? inlineNames.get(message.speaker)?.name);
  }
  for (const message of messages.values()) {
    for (const [id, inline] of mentionedUsers(message.content)) {
      if (names.get(id) === undefined) names.set(id, directory.get(id)?.name ?? inlineNames.get(id)?.name ?? inline);
    }
  }
  const { labels, participants } = assignLabels(names, bots);
  const meta: ConversationMetaRecord = {
    role: "meta",
    source: "slack",
    channel,
    ...(input.channelName === undefined ? {} : { channel_name: input.channelName }),
    participants,
  };
  const toMessage = (snapshot: Snapshot): ConversationMessage => ({
    id: snapshot.ts,
    speaker: labels.get(snapshot.speaker) ?? snapshot.speaker,
    content: resolveMentions(snapshot.content, labels),
    timestamp: snapshot.timestamp,
    ...(snapshot.reactions === undefined ? {} : { reactions: snapshot.reactions }),
  });

  const repliesOf = new Map<string, ConversationMessage[]>();
  for (const message of messages.values()) {
    if (message.ts === message.thread) continue;
    const replies = repliesOf.get(message.thread);
    if (replies) replies.push(toMessage(message));
    else repliesOf.set(message.thread, [toMessage(message)]);
  }
  const roots = new Set([...messages.values()].filter((m) => m.ts === m.thread).map((m) => m.ts));
  const posts: (ConversationPost | ConversationThreadFragment)[] = [];
  for (const thread of new Set([...roots, ...repliesOf.keys()])) {
    const replies = repliesOf.get(thread) ?? [];
    const root = roots.has(thread) ? messages.get(thread) : undefined;
    if (root) {
      posts.push(replies.length > 0 ? { ...toMessage(root), replies } : toMessage(root));
    } else {
      diagnostics.push({
        code: "slack_missing_root",
        message: "Thread replies were present without their root; the root was not fabricated.",
      });
      posts.push({ id: thread, missing_root: true, replies });
    }
  }
  posts.sort((a, b) => compareSlackTimestamps(a.id, b.id));
  return { records: [meta, ...posts], diagnostics };
}

/**
 * Keep one copy of a message seen more than once, such as a reply fetched through both
 * history and replies. Conflicting copies prefer the latest edit, then the most reactions,
 * so the choice does not depend on transport arrival order.
 */
function reconcile(snapshots: Snapshot[], diagnostics: ConversationDiagnostic[]): Snapshot {
  const [first, ...rest] = snapshots;
  if (!first) throw invalid("Slack message has no snapshot.");
  if (rest.some((s) => s.thread !== first.thread || s.speaker !== first.speaker)) {
    throw invalid("Conflicting thread or speaker for one Slack message; supply one authoritative snapshot.");
  }
  const kept = snapshots.reduce((best, candidate) => (rank(candidate, best) > 0 ? candidate : best));
  for (const snapshot of snapshots) {
    if (snapshot === kept) continue;
    if (key(snapshot) === key(kept)) {
      diagnostics.push({ code: "slack_duplicate_message", message: "Removed a duplicate Slack message." });
    } else {
      diagnostics.push({
        code: "slack_conflicting_message",
        message: "Kept one of conflicting Slack message snapshots (latest edit, then most reactions).",
      });
    }
  }
  return kept;
}

function rank(a: Snapshot, b: Snapshot): number {
  const edited = compareSlackTimestamps(a.edited ?? "0.000000", b.edited ?? "0.000000");
  if (edited !== 0) return edited;
  const reactions = reactionTotal(a) - reactionTotal(b);
  if (reactions !== 0) return reactions;
  return compareText(key(a), key(b));
}

function reactionTotal(snapshot: Snapshot): number {
  if (snapshot.reactions === undefined) return -1;
  return Object.values(snapshot.reactions).reduce((sum, count) => sum + count, 0);
}

function key(snapshot: Snapshot): string {
  return JSON.stringify([snapshot.content, snapshot.reactions ?? null]);
}

/** Accept the shapes a Slack channel dump actually comes in. An empty dump is an empty channel. */
function parseSlackMessages(transcript: string): unknown[] {
  if (!transcript.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    const lines = transcript.split(/\r?\n/).filter((line) => line.trim());
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw invalid(`Slack transcript line ${index + 1} is not valid JSON.`);
      }
    });
  }
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.messages)) return parsed.messages;
  throw invalid("Slack transcript must be JSONL rows, a JSON array, or a conversations.history response.");
}

function invalid(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
