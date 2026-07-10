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

    for (const message of parseMessages(transcript)) {
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

function parseMessages(transcript: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidLettaTranscript();
  }
  if (!Array.isArray(parsed) || !parsed.every(isObject)) {
    throw invalidLettaTranscript();
  }
  const messages = parsed as Record<string, unknown>[];
  if (!messages.every((message) => typeof message.seq_id === "number")) {
    return messages;
  }
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        (left.message.seq_id as number) -
          (right.message.seq_id as number) ||
        left.index - right.index,
    )
    .map(({ message }) => message);
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
    "Letta transcript must be a flat JSON array of native Letta messages.",
  );
}
