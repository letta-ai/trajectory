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
        decodeLocalMessage(entry.message, entry.timestamp, entry.byteOffset, events);
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
      // Native identity: the message `id`, ordered by `seq_id`.
      const id =
        typeof message.id === "string" && message.id ? message.id : undefined;
      const seq =
        typeof message.seq_id === "number" ? message.seq_id : undefined;
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          ...(id !== undefined ? { sourceRecordId: id } : {}),
          ...(seq !== undefined ? { sourceSequence: seq } : {}),
          componentIndex: componentIndex++,
        });
      };

      if (
        message.message_type === "user_message" ||
        message.message_type === "assistant_message"
      ) {
        const content = blocksText(message.content);
        if (content) {
          emit({
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
          emit({
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
          emit({
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
          emit({
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

type LocalMessageEntry = {
  message: Record<string, unknown>;
  timestamp?: Date;
  /** Absolute UTF-8 byte offset of this row within the transcript. */
  byteOffset: number;
};

type ParsedTranscript =
  | { format: "api"; messages: Record<string, unknown>[] }
  | {
      format: "local";
      messages: LocalMessageEntry[];
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
    // A single-line v3 continuation is one `type:"session"` or `type:"message"`
    // wrapper row that parses as whole-input JSON; route it to the JSONL parser.
    if (parsed.type === "session" || parsed.type === "message") {
      return parseLocalJsonLines(transcript);
    }
    if (typeof parsed.role === "string") {
      const timestamp = messageTimestamp(parsed);
      return {
        format: "local",
        messages: [
          {
            message: parsed,
            byteOffset: 0,
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
  const rows: Array<{ row: Record<string, unknown>; byteOffset: number }> = [];
  let byteOffset = 0;
  for (const raw of transcript.split("\n")) {
    const rowByteOffset = byteOffset;
    // Advance past this row's bytes plus the "\n" separator that split removed.
    byteOffset += utf8ByteLength(raw) + 1;
    if (!raw.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      throw invalidLettaTranscript();
    }
    if (!isObject(row)) throw invalidLettaTranscript();
    rows.push({ row, byteOffset: rowByteOffset });
  }
  if (rows.length === 0) throw invalidLettaTranscript();

  const session = rows.find((entry) => entry.row.type === "session");
  if (session && session.row.version !== 3) {
    throw new NormalizationError(
      "invalid_input",
      `Unsupported Letta local transcript version ${JSON.stringify(session.row.version)}; supported version: 3.`,
    );
  }

  // Version 3 files use `type: "message"` wrapper rows. A standalone continuation
  // chunk contains those wrapper rows without the leading `type: "session"` row,
  // so detect the wrapper shape directly rather than requiring the session row.
  const hasMessageWrappers = rows.some((entry) => entry.row.type === "message");
  if (session || hasMessageWrappers) {
    const createdAt = session ? parseTimestamp(session.row.timestamp) : undefined;
    return {
      format: "local",
      messages: rows.flatMap((entry) => {
        if (entry.row.type !== "message" || !isObject(entry.row.message)) return [];
        const timestamp = parseTimestamp(entry.row.timestamp);
        return [
          {
            message: entry.row.message,
            byteOffset: entry.byteOffset,
            ...(timestamp ? { timestamp } : {}),
          },
        ];
      }),
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (!rows.every((entry) => typeof entry.row.role === "string")) {
    throw invalidLettaTranscript();
  }
  return {
    format: "local",
    messages: rows.map((entry) => {
      const timestamp = messageTimestamp(entry.row);
      return {
        message: entry.row,
        byteOffset: entry.byteOffset,
        ...(timestamp ? { timestamp } : {}),
      };
    }),
  };
}

function decodeLocalMessage(
  message: Record<string, unknown>,
  entryTimestamp: Date | undefined,
  byteOffset: number,
  events: DecodedEvent[],
): void {
  const timestamp = entryTimestamp ?? messageTimestamp(message);
  const model = typeof message.model === "string" ? message.model : undefined;
  // Prefer a native message id; otherwise anchor identity to the absolute UTF-8
  // byte offset so it is stable across chunked uploads (kind `byte`).
  const id = typeof message.id === "string" && message.id ? message.id : undefined;
  let componentIndex = 0;
  const emit = (event: DecodedEvent): void => {
    events.push({
      ...event,
      ...(id !== undefined
        ? { sourceRecordId: id }
        : { sourceOffset: byteOffset, sourceAnchorKind: "byte" }),
      componentIndex: componentIndex++,
    });
  };

  if (message.role === "user") {
    const content = blocksText(message.content);
    if (content) {
      emit({
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
        emit({
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
        emit({
          type: "reasoning",
          content: part.thinking,
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      } else if (part.type === "text" && typeof part.text === "string") {
        emit({
          type: "message",
          role: "assistant",
          content: part.text,
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      } else if (part.type === "toolCall") {
        emit({
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
    emit({
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

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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
