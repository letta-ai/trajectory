/** Sources with implemented conversation adapters, separate from agent harnesses. */
export type ConversationSource = "slack";

export interface NormalizeConversationInput {
  source: ConversationSource;
  transcript: string;
}

export interface ConversationMetaRecord {
  role: "meta";
  source: string;
  /** Source-native thread ID, scoped by source_metadata. */
  conversation_id: string;
  source_metadata?: Record<string, string>;
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
  users: string[];
}

export interface ConversationMessageMetadata {
  reactions?: ConversationReaction[];
}

export interface ConversationMessageRecord {
  role: "message";
  /** Source-native message ID, unique within this conversation. */
  id: string;
  speaker: ConversationSpeaker;
  metadata?: ConversationMessageMetadata;
  content: string;
  timestamp: string;
}

export type ConversationRecord = ConversationMetaRecord | ConversationMessageRecord;
export type Conversation = [ConversationMetaRecord, ...ConversationMessageRecord[]];

export interface ConversationDiagnostic {
  code: "slack_message_dropped" | "slack_duplicate_message";
  message: string;
}

export interface NormalizeConversationResult {
  records: Conversation;
  diagnostics: ConversationDiagnostic[];
}
