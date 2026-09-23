/** Sources with implemented conversation adapters, separate from agent harnesses. */
export type ConversationSource = "slack";

export interface NormalizeConversationInput {
  source: ConversationSource;
  /** One channel's raw messages: JSONL rows, a JSON array, or a `conversations.history` response. */
  transcript: string;
  /** The channel the messages were fetched from; Slack does not echo it on messages. */
  channel: string;
  /** Raw `users.list` objects, used only to resolve display names. */
  users?: unknown[];
}

export interface ConversationMetaRecord {
  role: "meta";
  source: string;
  channel: string;
}

export interface ConversationSpeaker {
  id: string;
  /** Optional display label, never a replacement for source identity. */
  name?: string;
}

export interface ConversationReaction {
  name: string;
  /** Total source-reported count; users may be a partial list. */
  count: number;
  users: ConversationSpeaker[];
}

export interface ConversationMessage {
  /** Source-native message ID, unique within the conversation. */
  id: string;
  speaker: ConversationSpeaker;
  content: string;
  timestamp: string;
  reactions?: ConversationReaction[];
}

/** A top-level post; `replies` is present only when the thread has replies. */
export interface ConversationPost extends ConversationMessage {
  replies?: ConversationMessage[];
}

/** Replies whose root was not in the input. `id` is the root's source ID. */
export interface ConversationThreadFragment {
  id: string;
  replies: ConversationMessage[];
}

export type ConversationRecord =
  | ConversationMetaRecord
  | ConversationPost
  | ConversationThreadFragment;
export type Conversation = [
  ConversationMetaRecord,
  ...(ConversationPost | ConversationThreadFragment)[],
];

export interface ConversationDiagnostic {
  code: "slack_message_dropped" | "slack_duplicate_message" | "slack_missing_root";
  message: string;
}

export interface NormalizeConversationResult {
  records: Conversation;
  diagnostics: ConversationDiagnostic[];
}
