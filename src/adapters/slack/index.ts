import type {
  ConversationDiagnostic,
  ConversationMessage,
  ConversationPost,
  ConversationThreadFragment,
  NormalizeConversationResult,
} from "../../conversations/types.js";
import { NormalizationError } from "../../types.js";
import { isObject, nonemptyString } from "../shared.js";
import { compareSlackTimestamps, parseSlackTimestamp } from "./timestamp.js";
import { buildUserNames, readReactions, resolveSpeaker } from "./metadata.js";

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
  users?: unknown[];
}

/** One channel's raw messages become one conversation: posts in order, replies nested once. */
export function normalizeSlackChannel(input: SlackChannelInput): NormalizeConversationResult {
  const channel = nonemptyString(input.channel);
  if (!channel) throw invalid("Slack input requires the channel the messages were fetched from.");
  const userNames = buildUserNames(input.users);
  const diagnostics: ConversationDiagnostic[] = [];
  const messages = new Map<string, ConversationMessage>();
  const threadOf = new Map<string, string>();
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
    const speakerId = nonemptyString(raw.user) ?? nonemptyString(raw.bot_id);
    if (!speakerId) throw invalid("Slack message has no source speaker identity.");
    // Text is the canonical message body. Blocks and unfurls usually duplicate it.
    // Do not interpret relayed '*User*'/'*Assistant*' labels as source identities.
    if (typeof raw.text !== "string" || !raw.text.trim()) {
      diagnostics.push({
        code: "slack_message_dropped",
        message: "Skipped a Slack post without nonempty text (blocks/files are not extracted).",
      });
      continue;
    }
    const message: ConversationMessage = {
      id: time.ts,
      speaker: resolveSpeaker(raw, speakerId, userNames),
      content: raw.text,
      timestamp: time.date.toISOString(),
      ...("reactions" in raw ? { reactions: readReactions(raw.reactions) } : {}),
    };
    const existing = messages.get(time.ts);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(message) || threadOf.get(time.ts) !== thread.ts) {
        throw invalid("Conflicting versions of a Slack message; supply one authoritative snapshot.");
      }
      diagnostics.push({
        code: "slack_duplicate_message",
        message: "Removed a duplicate Slack message.",
      });
      continue;
    }
    messages.set(time.ts, message);
    threadOf.set(time.ts, thread.ts);
  }
  if (messages.size === 0) throw invalid("Slack channel contains no supported text messages.");

  const repliesOf = new Map<string, ConversationMessage[]>();
  for (const [ts, thread] of threadOf) {
    if (ts === thread) continue;
    const reply = messages.get(ts);
    if (!reply) continue;
    const replies = repliesOf.get(thread);
    if (replies) replies.push(reply);
    else repliesOf.set(thread, [reply]);
  }
  const roots = new Set<string>([...messages.keys()].filter((ts) => threadOf.get(ts) === ts));
  const posts: (ConversationPost | ConversationThreadFragment)[] = [];
  for (const thread of new Set([...roots, ...repliesOf.keys()])) {
    const replies = (repliesOf.get(thread) ?? []).sort((a, b) => compareSlackTimestamps(a.id, b.id));
    const root = roots.has(thread) ? messages.get(thread) : undefined;
    if (root) {
      posts.push(replies.length > 0 ? { ...root, replies } : root);
    } else {
      diagnostics.push({
        code: "slack_missing_root",
        message: "Thread replies were present without their root; the root was not fabricated.",
      });
      posts.push({ id: thread, replies });
    }
  }
  posts.sort((a, b) => compareSlackTimestamps(a.id, b.id));
  return {
    records: [{ role: "meta", source: "slack", channel }, ...posts],
    diagnostics,
  };
}

/** Accept the shapes a Slack channel dump actually comes in. */
function parseSlackMessages(transcript: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    const lines = transcript.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) throw invalid("Slack transcript is empty.");
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
