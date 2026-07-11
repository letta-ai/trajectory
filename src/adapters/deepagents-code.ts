import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../internal.js";
import type { Diagnostic } from "../types.js";
import { NormalizationError } from "../types.js";
import { isObject, jsonString, parseTimestamp } from "./shared.js";

const TRANSCRIPT_TYPE = "deepagents-code-thread";
const TRANSCRIPT_VERSION = 1;
const SYNTHETIC_SYSTEM_PREFIX = "[SYSTEM]";

export interface DeepAgentsCodeMessage {
  message: Record<string, unknown>;
  timestamp?: string;
}

export interface DeepAgentsCodeMetadata {
  cwd?: string;
  git_branch?: string;
  agent_name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DeepAgentsCodeTranscriptEnvelope {
  type: typeof TRANSCRIPT_TYPE;
  version: typeof TRANSCRIPT_VERSION;
  thread_id: string;
  checkpoint_ns: string;
  messages: DeepAgentsCodeMessage[];
  metadata?: DeepAgentsCodeMetadata;
}

/** Decode a safe JSON envelope containing reconstructed message dictionaries. */
export const deepAgentsCodeAdapter: SourceAdapter = {
  source: "deepagents-code",

  decode(transcript: string): DecodedSession {
    const envelope = parseEnvelope(transcript);
    const events: DecodedEvent[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const entry of envelope.messages) {
      decodeMessage(
        entry.message,
        parseTimestamp(entry.timestamp),
        events,
        diagnostics,
      );
    }

    const metadata = isObject(envelope.metadata) ? envelope.metadata : {};
    const createdAt = parseTimestamp(metadata.created_at);
    const updatedAt = parseTimestamp(metadata.updated_at);
    return {
      events,
      context: {
        source: "deepagents-code",
        ...(typeof metadata.cwd === "string" && metadata.cwd
          ? { cwd: metadata.cwd }
          : {}),
        ...(typeof metadata.git_branch === "string" && metadata.git_branch
          ? { gitBranch: metadata.git_branch }
          : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(createdAt && updatedAt && updatedAt >= createdAt
          ? {
              durationSeconds:
                (updatedAt.getTime() - createdAt.getTime()) / 1_000,
            }
          : {}),
      },
      diagnostics,
    };
  },
};

function parseEnvelope(transcript: string): DeepAgentsCodeTranscriptEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidEnvelope();
  }
  if (
    !isObject(parsed) ||
    parsed.type !== TRANSCRIPT_TYPE ||
    parsed.version !== TRANSCRIPT_VERSION ||
    typeof parsed.thread_id !== "string" ||
    typeof parsed.checkpoint_ns !== "string" ||
    !Array.isArray(parsed.messages) ||
    !parsed.messages.every(
      (entry) =>
        isObject(entry) &&
        isObject(entry.message) &&
        (entry.timestamp === undefined || typeof entry.timestamp === "string"),
    ) ||
    (parsed.metadata !== undefined && !isObject(parsed.metadata))
  ) {
    throw invalidEnvelope();
  }
  return parsed as unknown as DeepAgentsCodeTranscriptEnvelope;
}

function invalidEnvelope(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    `Deep Agents Code transcript must be a version ${TRANSCRIPT_VERSION} ${JSON.stringify(TRANSCRIPT_TYPE)} JSON envelope.`,
  );
}

function decodeMessage(
  message: Record<string, unknown>,
  timestamp: Date | undefined,
  events: DecodedEvent[],
  diagnostics: Diagnostic[],
): void {
  const type = messageType(message);
  if (type === "remove") return;

  if (type === "system") {
    diagnostics.push({
      code: "system_message_dropped",
      message:
        "Dropped a Deep Agents Code system message because trajectory-v1 has no system role.",
    });
    return;
  }

  const content = messageText(message.content);
  if (type === "human") {
    if (content.startsWith(SYNTHETIC_SYSTEM_PREFIX)) {
      diagnostics.push({
        code: "system_message_dropped",
        message: "Dropped a synthetic Deep Agents Code system notification.",
      });
    } else if (content) {
      events.push({
        type: "message",
        role: "user",
        content,
        ...(timestamp ? { timestamp } : {}),
      });
    }
    return;
  }

  if (type === "tool" || type === "function") {
    const callId =
      typeof message.tool_call_id === "string" && message.tool_call_id
        ? message.tool_call_id
        : undefined;
    events.push({
      type: "tool_result",
      content,
      ...(callId ? { callId } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
    return;
  }

  if (type !== "ai") return;
  const model = messageModel(message);
  const reasoning = messageReasoning(message);
  if (reasoning) {
    events.push({
      type: "reasoning",
      content: reasoning,
      ...(model ? { model } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
  if (content) {
    events.push({
      type: "message",
      role: "assistant",
      content,
      ...(model ? { model } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isObject(call)) continue;
    events.push({
      type: "tool_call",
      args: toolArguments(call.args),
      ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
      ...(typeof call.name === "string" && call.name ? { name: call.name } : {}),
      ...(model ? { model } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
}

function messageType(message: Record<string, unknown>): string | undefined {
  if (typeof message.type === "string") return message.type;
  if (typeof message.role === "string") {
    if (message.role === "user") return "human";
    if (message.role === "assistant") return "ai";
    return message.role;
  }
  const className = message.__langgraph_class;
  if (typeof className !== "string") return undefined;
  if (className.startsWith("HumanMessage")) return "human";
  if (className.startsWith("AIMessage")) return "ai";
  if (className.startsWith("ToolMessage")) return "tool";
  if (className.startsWith("SystemMessage")) return "system";
  if (className.startsWith("FunctionMessage")) return "function";
  if (className === "RemoveMessage") return "remove";
  return undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content == null ? "" : jsonString({ content });
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    if (
      part.type === "text" ||
      part.type === "input_text" ||
      part.type === "output_text"
    ) {
      if (typeof part.text === "string") parts.push(part.text);
    } else if (part.type === "image" || part.type === "image_url") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function messageReasoning(message: Record<string, unknown>): string {
  const additional = isObject(message.additional_kwargs)
    ? message.additional_kwargs
    : {};
  if (typeof additional.reasoning_content === "string") {
    return additional.reasoning_content;
  }
  const parts: string[] = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!isObject(part)) continue;
    if (part.type === "reasoning" || part.type === "thinking") {
      const text =
        typeof part.reasoning === "string"
          ? part.reasoning
          : typeof part.thinking === "string"
            ? part.thinking
            : part.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function messageModel(message: Record<string, unknown>): string | undefined {
  const response = isObject(message.response_metadata)
    ? message.response_metadata
    : {};
  const additional = isObject(message.additional_kwargs)
    ? message.additional_kwargs
    : {};
  for (const value of [response.model_name, response.model, additional.model]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function toolArguments(value: unknown): string {
  if (typeof value === "string" && value) return value;
  return jsonString(value);
}
