import { normalizeSlackThread } from "../adapters/slack/index.js";
import { NormalizationError } from "../types.js";
import type { NormalizeConversationInput, NormalizeConversationResult } from "./types.js";
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

export { validateConversation } from "./validate.js";
export { NormalizationError } from "../types.js";
export type {
  Conversation,
  ConversationRecord,
  ConversationMetaRecord,
  ConversationMessageRecord,
  ConversationSpeaker,
  ConversationSource,
  ConversationDiagnostic,
  NormalizeConversationInput,
  NormalizeConversationResult,
} from "./types.js";
