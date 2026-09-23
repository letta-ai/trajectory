import { normalizeSlackChannel } from "../adapters/slack/index.js";
import { NormalizationError } from "../types.js";
import type { NormalizeConversationInput, NormalizeConversationResult } from "./types.js";
import { validateConversation } from "./validate.js";

/** Normalize one channel's raw messages into one imported conversation, not an agent trajectory. */
export function normalizeConversation(input: NormalizeConversationInput): NormalizeConversationResult {
  if (!input || typeof input !== "object" || typeof input.transcript !== "string") {
    throw new NormalizationError("invalid_input", "Expected a conversation source, transcript string, and channel.");
  }
  if (input.source !== "slack") {
    throw new NormalizationError("unknown_source", `Unsupported conversation source: ${input.source}`);
  }
  if (input.users !== undefined && !Array.isArray(input.users)) {
    throw new NormalizationError("invalid_input", "Slack users must be an array.");
  }
  const result = normalizeSlackChannel({
    transcript: input.transcript,
    channel: input.channel,
    ...(input.users === undefined ? {} : { users: input.users }),
  });
  validateConversation(result.records);
  return result;
}

export { validateConversation } from "./validate.js";
export { NormalizationError } from "../types.js";
export type {
  Conversation,
  ConversationRecord,
  ConversationMetaRecord,
  ConversationMessage,
  ConversationPost,
  ConversationThreadFragment,
  ConversationSpeaker,
  ConversationReaction,
  ConversationSource,
  ConversationDiagnostic,
  NormalizeConversationInput,
  NormalizeConversationResult,
} from "./types.js";
