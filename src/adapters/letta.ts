import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../internal.js";
import { NormalizationError } from "../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseTimestamp,
} from "./shared.js";

export const lettaAdapter: SourceAdapter = {
  source: "letta",

  decode(transcript: string): DecodedSession {
    const events: DecodedEvent[] = [];
    const parsed = parseTranscript(transcript);

    if (parsed.format === "local") {
      for (const entry of parsed.messages) {
        decodeLocalMessage(entry.message, entry.timestamp, events);
      }
      return {
        events,
        context: {
          source: "letta",
          ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {}),
        },
        diagnostics: [],
      };
    }

    for (const message of parsed.messages) {
      const timestamp = parseTimestamp(message.date);

      if (
        message.message_type === "user_message" ||
        message.message_type === "assistant_message"
      ) {
        const content = blocksText(message.content);
        if (content) {
          events.push({
            type: "message",
            role:
              message.message_type === "user_message" ? "user" : "assistant",
            content,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (message.message_type === "reasoning_message") {
        if (typeof message.reasoning === "string" && message.reasoning) {
          events.push({
            type: "reasoning",
            content: message.reasoning,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (
        message.message_type === "tool_call_message" ||
        message.message_type === "approval_request_message"
      ) {
        for (const call of messageToolCalls(message)) {
          events.push({
            type: "tool_call",
            args: toolArguments(call.arguments),
            ...(typeof call.tool_call_id === "string" && call.tool_call_id
              ? { id: call.tool_call_id }
              : {}),
            ...(typeof call.name === "string" && call.name
              ? { name: call.name }
              : {}),
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (message.message_type === "tool_return_message") {
        for (const result of messageToolReturns(message)) {
          let content = toolReturnText(result.tool_return);
          if (
            (result.is_err === true ||
              (typeof result.status === "string" &&
                result.status !== "success")) &&
            !/^error/i.test(content)
          ) {
            content = `Error: ${content}`;
          }
          events.push({
            type: "tool_result",
            content,
            ...(typeof result.tool_call_id === "string" && result.tool_call_id
              ? { callId: result.tool_call_id }
              : {}),
            ...(timestamp ? { timestamp } : {}),
          });
        }
      }
    }

    return {
      events,
      context: { source: "letta" },
      diagnostics: [],
    };
  },
};

type ParsedTranscript =
  | { format: "api"; messages: Record<string, unknown>[] }
  | {
      format: "local";
      messages: Array<{
        message: Record<string, unknown>;
        timestamp?: Date;
      }>;
      createdAt?: Date;
    };

function parseTranscript(transcript: string): ParsedTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    return parseLocalJsonLines(transcript);
  }
  if (isObject(parsed)) {
    if (parsed.type === "session") return parseLocalJsonLines(transcript);
    if (typeof parsed.role === "string") {
      const timestamp = messageTimestamp(parsed);
      return {
        format: "local",
        messages: [
          {
            message: parsed,
            ...(timestamp ? { timestamp } : {}),
          },
        ],
      };
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(isObject)) {
    throw invalidLettaTranscript();
  }
  const messages = parsed as Record<string, unknown>[];
  if (!messages.every((message) => typeof message.seq_id === "number")) {
    return { format: "api", messages };
  }
  return {
    format: "api",
    messages: messages
      .map((message, index) => ({ message, index }))
      .sort(
        (left, right) =>
          (left.message.seq_id as number) -
            (right.message.seq_id as number) ||
          left.index - right.index,
      )
      .map(({ message }) => message),
  };
}

function parseLocalJsonLines(transcript: string): ParsedTranscript {
  const rows: Record<string, unknown>[] = [];
  for (const raw of transcript.split("\n")) {
    if (!raw.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      throw invalidLettaTranscript();
    }
    if (!isObject(row)) throw invalidLettaTranscript();
    rows.push(row);
  }
  if (rows.length === 0) throw invalidLettaTranscript();

  const session = rows.find((row) => row.type === "session");
  if (session) {
    if (session.version !== 3) {
      throw new NormalizationError(
        "invalid_input",
        `Unsupported Letta local transcript version ${JSON.stringify(session.version)}; supported version: 3.`,
      );
    }
    const createdAt = parseTimestamp(session.timestamp);
    return {
      format: "local",
      messages: rows.flatMap((row) => {
        if (row.type !== "message" || !isObject(row.message)) return [];
        const timestamp = parseTimestamp(row.timestamp);
        return [
          {
            message: row.message,
            ...(timestamp ? { timestamp } : {}),
          },
        ];
      }),
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (!rows.every((row) => typeof row.role === "string")) {
    throw invalidLettaTranscript();
  }
  return {
    format: "local",
    messages: rows.map((message) => {
      const timestamp = messageTimestamp(message);
      return {
        message,
        ...(timestamp ? { timestamp } : {}),
      };
    }),
  };
}

function decodeLocalMessage(
  message: Record<string, unknown>,
  entryTimestamp: Date | undefined,
  events: DecodedEvent[],
): void {
  const timestamp = entryTimestamp ?? messageTimestamp(message);
  const model = typeof message.model === "string" ? message.model : undefined;

  if (message.role === "user") {
    const content = blocksText(message.content);
    if (content) {
      events.push({
        type: "message",
        role: "user",
        content,
        ...(timestamp ? { timestamp } : {}),
      });
    }
    return;
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      if (message.content) {
        events.push({
          type: "message",
          role: "assistant",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      }
      return;
    }
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!isObject(part)) continue;
      if (part.type === "thinking" && typeof part.thinking === "string") {
        events.push({
          type: "reasoning",
          content: part.thinking,
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      } else if (part.type === "text" && typeof part.text === "string") {
        events.push({
          type: "message",
          role: "assistant",
          content: part.text,
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      } else if (part.type === "toolCall") {
        events.push({
          type: "tool_call",
          args: toolArguments(part.arguments),
          ...(typeof part.id === "string" && part.id ? { id: part.id } : {}),
          ...(typeof part.name === "string" && part.name
            ? { name: part.name }
            : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      }
    }
    return;
  }

  if (message.role === "toolResult" || message.role === "tool") {
    let content = blocksText(message.content);
    if (message.isError === true && !/^error/i.test(content)) {
      content = `Error: ${content}`;
    }
    const callId =
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : typeof message.tool_call_id === "string"
          ? message.tool_call_id
          : undefined;
    events.push({
      type: "tool_result",
      content,
      ...(callId ? { callId } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
}

function messageTimestamp(message: Record<string, unknown>): Date | undefined {
  const metadata = isObject(message.metadata) ? message.metadata : {};
  return (
    parseTimestamp(metadata.created_at) ??
    parseTimestamp(message.date) ??
    parseTimestamp(message.timestamp)
  );
}

function toolArguments(value: unknown): string {
  if (typeof value === "string" && value) return value;
  return jsonString(value);
}

function toolReturnText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return jsonString(value);
}

function messageToolCalls(
  message: Record<string, unknown>,
): Record<string, unknown>[] {
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isObject)
    : [];
  if (calls.length > 0) return uniqueByCallId(calls);
  return isObject(message.tool_call) ? [message.tool_call] : [];
}

function messageToolReturns(
  message: Record<string, unknown>,
): Record<string, unknown>[] {
  const results = Array.isArray(message.tool_returns)
    ? message.tool_returns.filter(isObject)
    : [];
  if (results.length > 0) return uniqueByCallId(results);
  return [message];
}

function uniqueByCallId(
  values: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (typeof value.tool_call_id !== "string" || !value.tool_call_id) {
      return true;
    }
    if (seen.has(value.tool_call_id)) return false;
    seen.add(value.tool_call_id);
    return true;
  });
}

function invalidLettaTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "Letta transcript must be a native message array or local conversation JSONL.",
  );
}
