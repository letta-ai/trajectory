/** Sources with implemented conversation adapters, separate from agent harnesses. */
export type ConversationSource = "slack";

export interface NormalizeConversationInput {
  source: ConversationSource;
  /** One channel's raw messages: JSONL rows, a JSON array, or a `conversations.history` response. */
  transcript: string;
  /** The channel the messages were fetched from; Slack does not echo it on messages. */
  channel: string;
  /** Optional readable channel name, such as `conversations.info`'s `name`. */
  channelName?: string;
  /** Raw `users.list` objects, used only to resolve display names and bot flags. */
  users?: unknown[];
}

export interface ConversationParticipant {
  /** Source-native participant ID. */
  id: string;
  /** Present only for bots and apps. */
  bot?: true;
}

export interface ConversationMetaRecord {
  role: "meta";
  source: string;
  channel: string;
  channel_name?: string;
  /** Each label used as a `speaker` or `@` mention, mapped once to its source identity. */
  participants: Record<string, ConversationParticipant>;
}

export interface ConversationMessage {
  /** Source-native message ID, unique within the conversation. */
  id: string;
  /** A key of `meta.participants`. */
  speaker: string;
  content: string;
  timestamp: string;
  /** Reaction name to the source-reported count. */
  reactions?: Record<string, number>;
}

/** A top-level post; `replies` is present only when the thread has replies. */
export interface ConversationPost extends ConversationMessage {
  replies?: ConversationMessage[];
}

/** Replies whose root was not in the input. `id` is the root's source ID. */
export interface ConversationThreadFragment {
  id: string;
  missing_root: true;
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
  code:
    | "slack_message_dropped"
    | "slack_duplicate_message"
    | "slack_conflicting_message"
    | "slack_missing_root";
  message: string;
}

export interface NormalizeConversationResult {
  records: Conversation;
  diagnostics: ConversationDiagnostic[];
}
