import type { SlackChannelContext } from "../../conversations/types.js";
import { NormalizationError } from "../../types.js";
import { isObject } from "../shared.js";
import { compareSlackTimestamps, parseSlackTimestamp } from "./timestamp.js";

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

/** Accept the shapes a Slack dump actually comes in; never a pre-built envelope. */
export function parseSlackMessages(transcript: string): unknown[] {
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
  if (isObject(parsed) && Array.isArray(parsed.messages) && !("thread_ts" in parsed)) {
    return parsed.messages;
  }
  throw invalid(
    "Slack transcript must be JSONL rows, a JSON array, or a conversations.history response.",
  );
}

function invalid(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
