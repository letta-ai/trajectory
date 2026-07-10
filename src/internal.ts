import type { Diagnostic, TrajectorySource } from "./types.js";

interface DecodedEventBase {
  timestamp?: Date;
  inputLine?: number;
  model?: string;
}

export interface DecodedMessageEvent extends DecodedEventBase {
  type: "message";
  role: "user" | "assistant";
  content: string;
}

export interface DecodedReasoningEvent extends DecodedEventBase {
  type: "reasoning";
  content: string;
}

export interface DecodedToolCallEvent extends DecodedEventBase {
  type: "tool_call";
  id?: string;
  name?: string;
  args: string;
}

export interface DecodedToolResultEvent extends DecodedEventBase {
  type: "tool_result";
  callId?: string;
  content: string;
}

export type DecodedEvent =
  | DecodedMessageEvent
  | DecodedReasoningEvent
  | DecodedToolCallEvent
  | DecodedToolResultEvent;

export interface SessionContext {
  source: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  createdAt?: Date;
  durationSeconds?: number;
}

export interface DecodedSession {
  events: DecodedEvent[];
  context: SessionContext;
  diagnostics: Diagnostic[];
}

export interface SourceAdapter {
  source: TrajectorySource;
  decode(transcript: string): DecodedSession;
}
