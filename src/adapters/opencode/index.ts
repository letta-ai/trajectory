import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { NormalizationError } from "../../types.js";
import {
  isObject,
  jsonString,
  nonemptyString,
  parseTimestamp,
} from "../shared.js";

const TRANSPORT_PART_TYPES = new Set([
  "file",
  "patch",
  "snapshot",
  "step-finish",
  "step-start",
  "subtask",
]);

/**
 * Decode an OpenCode whole-session export: `{ info, messages[].parts[] }`.
 * Despite the `.jsonl` suffix used by some corpora, this is one JSON document.
 */
export const openCodeAdapter: SourceAdapter = {
  source: "opencode",

  decode(transcript: string): DecodedSession {
    const document = parseOpenCodeDocument(transcript);
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const sessionInfo = isObject(document.info) ? document.info : {};
    let partOrdinal = 0;

    for (let messageIndex = 0; messageIndex < document.messages.length; messageIndex += 1) {
      const message = document.messages[messageIndex];
      if (!isObject(message)) continue;
      const info = isObject(message.info) ? message.info : {};
      const role = info.role;
      const messageId = nonemptyString(info.id);
      const timestamp = parseTimestamp(
        isObject(info.time) ? info.time.created : undefined,
      );
      const model = nonemptyString(info.modelID);
      const parts = Array.isArray(message.parts) ? message.parts : [];
      let messageComponentIndex = 0;
      let latestTimestamp: Date | undefined;
      const orderedTimestamp = (candidate: Date | undefined): Date | undefined => {
        if (!candidate) return latestTimestamp;
        if (latestTimestamp && candidate.getTime() < latestTimestamp.getTime()) {
          return latestTimestamp;
        }
        latestTimestamp = candidate;
        return candidate;
      };

      for (const part of parts) {
        const ordinal = partOrdinal++;
        if (!isObject(part)) continue;
        const partId = nonemptyString(part.id);
        const sourceRecordId = partId ?? messageId;
        let partComponentIndex = 0;
        const emit = (event: DecodedEvent): void => {
          const componentIndex = partId
            ? partComponentIndex++
            : messageId
              ? messageComponentIndex++
              : partComponentIndex++;
          events.push({
            ...event,
            ...(sourceRecordId
              ? { sourceRecordId }
              : { sourceOffset: ordinal, sourceAnchorKind: "ordinal" }),
            sourceSequence: ordinal,
            componentIndex,
          });
        };

        if (part.type === "text") {
          if (role !== "user" && role !== "assistant") continue;
          const partTime = isObject(part.time) ? part.time : {};
          const eventTimestamp = orderedTimestamp(
            parseTimestamp(partTime.start) ?? timestamp,
          );
          emit({
            type: "message",
            role,
            content: stringContent(part.text),
            ...(eventTimestamp ? { timestamp: eventTimestamp } : {}),
            ...(model ? { model } : {}),
          });
          continue;
        }

        if (part.type === "reasoning") {
          const partTime = isObject(part.time) ? part.time : {};
          const eventTimestamp = orderedTimestamp(
            parseTimestamp(partTime.start) ?? timestamp,
          );
          emit({
            type: "reasoning",
            content: stringContent(part.text),
            ...(eventTimestamp ? { timestamp: eventTimestamp } : {}),
            ...(model ? { model } : {}),
          });
          continue;
        }

        if (part.type === "tool") {
          const state = isObject(part.state) ? part.state : {};
          const stateTime = isObject(state.time) ? state.time : {};
          const callTimestamp = orderedTimestamp(
            parseTimestamp(stateTime.start) ?? timestamp,
          );
          const resultTimestamp = orderedTimestamp(
            parseTimestamp(stateTime.end) ?? callTimestamp,
          );
          const callId = nonemptyString(part.callID);
          const name = nonemptyString(part.tool);
          emit({
            type: "tool_call",
            args: jsonString(state.input),
            ...(callId ? { id: callId } : {}),
            ...(name ? { name } : {}),
            ...(callTimestamp ? { timestamp: callTimestamp } : {}),
            ...(model ? { model } : {}),
          });

          const status = nonemptyString(state.status);
          const output =
            state.output !== undefined
              ? stringContent(state.output)
              : status === "error"
                ? errorContent(state.error)
                : undefined;
          if (output !== undefined) {
            emit({
              type: "tool_result",
              content: output,
              ...(callId ? { callId } : {}),
              ...(status === "completed"
                ? { ok: true }
                : status === "error"
                  ? { ok: false }
                  : {}),
              ...(resultTimestamp ? { timestamp: resultTimestamp } : {}),
              ...(model ? { model } : {}),
            });
          }
          continue;
        }

        if (
          typeof part.type === "string" &&
          !TRANSPORT_PART_TYPES.has(part.type)
        ) {
          diagnostics.push({
            code: "noise_record_dropped",
            message:
              `Skipped unsupported OpenCode part type ${JSON.stringify(part.type)} ` +
              `in message ${messageIndex + 1}.`,
          });
        }
      }
    }

    const cwd = nonemptyString(sessionInfo.directory);
    const sourceGroupId = nonemptyString(sessionInfo.id);
    const createdAt = parseTimestamp(
      isObject(sessionInfo.time) ? sessionInfo.time.created : undefined,
    );
    return {
      events,
      context: {
        source: "opencode",
        ...(cwd ? { cwd } : {}),
        ...(sourceGroupId ? { sourceGroupId } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      diagnostics,
    };
  },
};

interface OpenCodeDocument extends Record<string, unknown> {
  messages: unknown[];
}

function parseOpenCodeDocument(transcript: string): OpenCodeDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidOpenCodeTranscript();
  }
  if (
    !isObject(parsed) ||
    !isObject(parsed.info) ||
    !Array.isArray(parsed.messages)
  ) {
    throw invalidOpenCodeTranscript();
  }
  return parsed as OpenCodeDocument;
}

function stringContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return isObject(value) || Array.isArray(value) ? jsonString(value) : String(value);
}

function errorContent(value: unknown): string {
  if (isObject(value) && typeof value.message === "string") return value.message;
  return stringContent(value);
}

function invalidOpenCodeTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "OpenCode transcript must be one JSON document with info and messages arrays of message parts.",
  );
}
