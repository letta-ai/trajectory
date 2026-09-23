import type { DecodedEvent, SourceAdapter } from "../../internal.js";
import { canonicalJson } from "../../canonical.js";
import type {
  Diagnostic,
  AttributedMessageRecord,
} from "../../types.js";
import { NormalizationError } from "../../types.js";
import { isObject, nonemptyString } from "../shared.js";
import { compareSlackTimestamps, parseSlackTimestamp } from "./timestamp.js";

const MESSAGE_SUBTYPES = new Set([
  "bot_message",
  "thread_broadcast",
  "file_share",
  "me_message",
]);

/** One thread envelope assembled by the caller from a raw Slack mirror. */
export const slackAdapter: SourceAdapter = {
  source: "slack",
  decode(transcript) {
    let input: unknown;
    try {
      input = JSON.parse(transcript);
    } catch {
      throw invalid("Expected a Slack thread JSON envelope, not bare JSONL.");
    }
    if (!isObject(input) || !Array.isArray(input.messages)) {
      throw invalid("Slack input must contain a messages array.");
    }
    const workspaceId = nonemptyString(input.team);
    const channelId = nonemptyString(input.channel);
    const thread = parseSlackTimestamp(input.thread_ts);
    if (!workspaceId || !channelId || !thread) {
      throw invalid(
        "Slack input requires team, channel, and a valid thread_ts.",
      );
    }
    const diagnostics: Diagnostic[] = [];
    const messages = new Map<string, Omit<AttributedMessageRecord, "timestamp">>();
    for (const raw of input.messages) {
      if (!isObject(raw)) throw invalid("Slack messages must be objects.");
      if (
        raw.type !== "message" ||
        (raw.subtype !== undefined &&
          !MESSAGE_SUBTYPES.has(String(raw.subtype)))
      ) {
        diagnostics.push({
          code: "slack_message_dropped",
          message: "Skipped an unsupported Slack event or message subtype.",
        });
        continue;
      }
      const time = parseSlackTimestamp(raw.ts);
      const threadTs = raw.thread_ts ?? raw.ts;
      if (!time || !parseSlackTimestamp(threadTs))
        throw invalid("Invalid Slack message timestamp.");
      if (
        threadTs !== thread.ts ||
        compareSlackTimestamps(time.ts, thread.ts) < 0
      ) {
        throw invalid(
          "Slack input contains a message from a different thread or preceding its root.",
        );
      }
      if (
        (raw.team !== undefined && raw.team !== workspaceId) ||
        (raw.channel !== undefined && raw.channel !== channelId)
      ) {
        throw invalid(
          "Slack message workspace/channel disagrees with the envelope.",
        );
      }
      const speakerId = nonemptyString(raw.user) ?? nonemptyString(raw.bot_id);
      if (!speakerId)
        throw invalid("Slack message has no source speaker identity.");
      // Text is the canonical message body. Blocks and unfurls usually duplicate it.
      // Do not interpret relayed '*User*'/'*Assistant*' labels as source identities.
      if (typeof raw.text !== "string" || !raw.text.trim()) {
        diagnostics.push({
          code: "slack_message_dropped",
          message:
            "Skipped a Slack post without nonempty text (blocks/files are not extracted).",
        });
        continue;
      }
      const message: Omit<AttributedMessageRecord, "timestamp"> = {
        role: "message",
        id: time.ts,
        speaker: { id: speakerId },
        content: raw.text,
      };
      const existing = messages.get(time.ts);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(message)) {
          throw invalid(
            "Conflicting versions of a Slack message; supply one authoritative snapshot.",
          );
        }
        diagnostics.push({
          code: "slack_duplicate_message",
          message: "Removed a duplicate Slack message.",
        });
      } else {
        messages.set(time.ts, message);
      }
    }
    if (messages.size === 0)
      throw invalid("Slack thread contains no supported text messages.");
    const events: DecodedEvent[] = [...messages.values()]
      .sort((a, b) => compareSlackTimestamps(a.id, b.id))
      .map((message) => {
        const time = parseSlackTimestamp(message.id);
        if (!time) throw invalid("Invalid Slack message timestamp.");
        return {
          type: "attributed_message",
          message,
          timestamp: time.date,
          sourceRecordId: JSON.stringify([workspaceId, channelId, message.id]),
          sourceSequence: time.sequence,
        };
      });
    return {
      events,
      context: {
        source: "slack",
        conversationId: thread.ts,
        sourceMetadata: { team: workspaceId, channel: channelId },
        sourceGroupId: JSON.stringify([workspaceId, channelId, thread.ts]),
      },
      diagnostics,
    };
  },
};

function invalid(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
