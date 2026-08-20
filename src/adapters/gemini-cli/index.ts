import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { NormalizationError } from "../../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  nonemptyString,
  parseTimestamp,
} from "../shared.js";

const TERMINAL_TOOL_STATUSES = new Set(["cancelled", "error", "success"]);

/** Decode Gemini CLI's native whole-session JSON document. */
export const geminiCliAdapter: SourceAdapter = {
  source: "gemini-cli",

  decode(transcript: string): DecodedSession {
    const document = parseGeminiDocument(transcript);
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];

    for (let messageIndex = 0; messageIndex < document.messages.length; messageIndex += 1) {
      const message = document.messages[messageIndex];
      if (!isObject(message)) continue;
      const messageType = message.type;
      if (messageType === "info") continue;

      const timestamp = parseTimestamp(message.timestamp);
      const model = nonemptyString(message.model);
      const sourceRecordId = nonemptyString(message.id);
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          ...(sourceRecordId
            ? { sourceRecordId }
            : { sourceOffset: messageIndex, sourceAnchorKind: "ordinal" }),
          sourceSequence: messageIndex,
          componentIndex: componentIndex++,
        });
      };

      if (messageType === "user") {
        emit({
          type: "message",
          role: "user",
          content: blocksText(message.content),
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      if (messageType !== "gemini") {
        diagnostics.push({
          code: "noise_record_dropped",
          message:
            `Skipped unsupported Gemini CLI message type ${JSON.stringify(messageType)} ` +
            `at position ${messageIndex + 1}.`,
        });
        continue;
      }

      if (Array.isArray(message.thoughts)) {
        for (const thought of message.thoughts) {
          const content = thoughtContent(thought);
          if (!content.trim()) continue;
          emit({
            type: "reasoning",
            content,
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
          });
        }
      }

      const content = blocksText(message.content);
      if (content.trim()) {
        emit({
          type: "message",
          role: "assistant",
          content,
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
        });
      }

      if (!Array.isArray(message.toolCalls)) continue;
      for (const rawCall of message.toolCalls) {
        if (!isObject(rawCall)) continue;
        const callId = nonemptyString(rawCall.id);
        const name = nonemptyString(rawCall.name);
        const callTimestamp = parseTimestamp(rawCall.timestamp) ?? timestamp;
        emit({
          type: "tool_call",
          args: jsonString(rawCall.args),
          ...(callId ? { id: callId } : {}),
          ...(name ? { name } : {}),
          ...(callTimestamp ? { timestamp: callTimestamp } : {}),
          ...(model ? { model } : {}),
        });

        const status = nonemptyString(rawCall.status);
        const outputs = toolOutputs(rawCall.result);
        if (outputs.length === 0 && (!status || !TERMINAL_TOOL_STATUSES.has(status))) {
          continue;
        }
        emit({
          type: "tool_result",
          content: outputs.join("\n"),
          ...(callId ? { callId } : {}),
          ...(status === "success"
            ? { ok: true }
            : status === "error" || status === "cancelled"
              ? { ok: false }
              : {}),
          ...(callTimestamp ? { timestamp: callTimestamp } : {}),
          ...(model ? { model } : {}),
        });
      }
    }

    const sourceGroupId = nonemptyString(document.sessionId);
    const sourceGroupRequired =
      !sourceGroupId && !nonemptyString(document.projectHash);
    const createdAt = parseTimestamp(document.startTime);
    return {
      events,
      context: {
        source: "gemini-cli",
        ...(sourceGroupId ? { sourceGroupId } : {}),
        ...(sourceGroupRequired ? { sourceGroupRequired: true } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      diagnostics,
    };
  },
};

interface GeminiDocument extends Record<string, unknown> {
  messages: unknown[];
}

function parseGeminiDocument(transcript: string): GeminiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidGeminiTranscript();
  }
  if (
    !isObject(parsed) ||
    !Array.isArray(parsed.messages)
  ) {
    throw invalidGeminiTranscript();
  }
  return parsed as GeminiDocument;
}

function thoughtContent(value: unknown): string {
  if (!isObject(value)) return String(value ?? "");
  return ["subject", "description"]
    .flatMap((key) =>
      typeof value[key] === "string" && value[key] ? [value[key]] : [],
    )
    .join(" — ");
}

function toolOutputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const outputs: string[] = [];
  for (const item of value) {
    if (!isObject(item) || !isObject(item.functionResponse)) continue;
    const response = item.functionResponse.response;
    if (!isObject(response)) continue;
    if (response.output !== undefined) {
      outputs.push(stringContent(response.output));
    } else if (Object.keys(response).length > 0) {
      outputs.push(jsonString(response));
    }
  }
  return outputs;
}

function stringContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return isObject(value) || Array.isArray(value) ? jsonString(value) : String(value);
}

function invalidGeminiTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "Gemini CLI transcript must be one native session JSON document with a messages array.",
  );
}
