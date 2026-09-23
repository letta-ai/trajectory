import { NormalizationError } from "../../types.js";
import { isObject } from "../shared.js";
import { compareSlackTimestamps, parseSlackTimestamp } from "./timestamp.js";

/** Context the caller already holds: Slack requires `channel` to fetch messages. */
export interface SlackChannelContext {
  team: string;
  channel: string;
  /** Raw `users.list` objects, used only to resolve display names. */
  users?: unknown[];
}

/** One thread envelope, accepted by `normalizeConversation` once JSON-stringified. */
export interface SlackThreadInput extends SlackChannelContext {
  thread_ts: string;
  messages: unknown[];
}

/**
 * Group one channel's raw Slack message objects into thread envelopes.
 * A message belongs to `thread_ts`, or is its own thread when unthreaded.
 * Messages are passed through untouched; the adapter validates them.
 */
export function groupSlackMessages(
  messages: unknown[],
  context: SlackChannelContext,
): SlackThreadInput[] {
  if (!Array.isArray(messages)) throw invalid("Slack messages must be an array.");
  const threads = new Map<string, unknown[]>();
  for (const raw of messages) {
    if (!isObject(raw)) throw invalid("Slack messages must be objects.");
    const key = parseSlackTimestamp(raw.thread_ts ?? raw.ts);
    if (!key) throw invalid("Invalid Slack message timestamp.");
    const group = threads.get(key.ts);
    if (group) group.push(raw);
    else threads.set(key.ts, [raw]);
  }
  return [...threads.entries()]
    .sort(([a], [b]) => compareSlackTimestamps(a, b))
    .map(([thread_ts, group]) => ({ ...context, thread_ts, messages: group }));
}

function invalid(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
