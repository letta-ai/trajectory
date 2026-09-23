import { groupSlackMessages, parseSlackMessages } from "../adapters/slack/group.js";
import { normalizeSlackThread } from "../adapters/slack/index.js";
import { NormalizationError } from "../types.js";
import type {
  NormalizeConversationInput,
  NormalizeConversationResult,
  NormalizeConversationsInput,
  NormalizeConversationsResult,
} from "./types.js";
import { validateConversation } from "./validate.js";

/** Normalize an imported conversation, not an agent execution trajectory. */
export function normalizeConversation(input: NormalizeConversationInput): NormalizeConversationResult {
  if (!input || typeof input !== "object" || typeof input.transcript !== "string") {
    throw new NormalizationError("invalid_input", "Expected a conversation source and transcript string.");
  }
  if (input.source !== "slack") {
    throw new NormalizationError("unknown_source", `Unsupported conversation source: ${input.source}`);
  }
  const result = normalizeSlackThread(input.transcript);
  validateConversation(result.records);
  return result;
}

/** Normalize one channel's raw Slack dump into one conversation per thread. */
export function normalizeConversations(input: NormalizeConversationsInput): NormalizeConversationsResult {
  if (!input || typeof input !== "object" || typeof input.transcript !== "string") {
    throw new NormalizationError("invalid_input", "Expected a conversation source, transcript string, and context.");
  }
  if (input.source !== "slack") {
    throw new NormalizationError("unknown_source", `Unsupported conversation source: ${input.source}`);
  }
  const { team, channel, users } = input.context ?? {};
  if (typeof team !== "string" || !team.trim() || typeof channel !== "string" || !channel.trim()) {
    throw new NormalizationError("invalid_input", "Slack context requires the team and channel the messages were fetched from.");
  }
  const threads = groupSlackMessages(parseSlackMessages(input.transcript), { team, channel, ...(users === undefined ? {} : { users }) });
  return {
    conversations: threads.map((thread) =>
      normalizeConversation({ source: "slack", transcript: JSON.stringify(thread) }),
    ),
  };
}

export { validateConversation } from "./validate.js";
export { groupSlackMessages } from "../adapters/slack/group.js";
export type { SlackThreadInput } from "../adapters/slack/group.js";
export { NormalizationError } from "../types.js";
export type {
  Conversation,
  ConversationRecord,
  ConversationMetaRecord,
  ConversationMessageRecord,
  ConversationSpeaker,
  ConversationReaction,
  ConversationMessageMetadata,
  ConversationSource,
  ConversationDiagnostic,
  NormalizeConversationInput,
  NormalizeConversationResult,
  NormalizeConversationsInput,
  NormalizeConversationsResult,
  SlackChannelContext,
} from "./types.js";
