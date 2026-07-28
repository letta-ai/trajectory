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
  parseJsonLines,
} from "../shared.js";

/** Decode Cursor's `{ role, message: { content } }` capture JSONL. */
export const cursorAdapter: SourceAdapter = {
  source: "cursor",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    let recognizedRows = 0;

    for (const { value: row, line, byteOffset } of parseJsonLines(
      transcript,
      diagnostics,
    )) {
      if (
        (row.role !== "user" && row.role !== "assistant") ||
        !isObject(row.message)
      ) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Cursor row on line ${line}.`,
          inputLine: line,
        });
        continue;
      }
      recognizedRows += 1;
      const role = row.role;
      const model =
        typeof row.message.model === "string" && row.message.model
          ? row.message.model
          : undefined;
      const content = row.message.content;
      const blocks = Array.isArray(content)
        ? content
        : [{ type: "text", text: typeof content === "string" ? content : "" }];
      const sourceRecordId =
        typeof row.id === "string" && row.id ? row.id : undefined;
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          ...(sourceRecordId
            ? { sourceRecordId }
            : { sourceOffset: byteOffset, sourceAnchorKind: "byte" }),
          sourceSequence: line - 1,
          componentIndex: componentIndex++,
          inputLine: line,
        });
      };

      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === "text") {
          emit({
            type: "message",
            role,
            content: typeof block.text === "string" ? block.text : "",
            ...(model ? { model } : {}),
          });
        } else if (block.type === "thinking") {
          emit({
            type: "reasoning",
            content:
              typeof block.thinking === "string" ? block.thinking : "",
            ...(model ? { model } : {}),
          });
        } else if (block.type === "tool_use") {
          emit({
            type: "tool_call",
            args: jsonString(block.input),
            ...(typeof block.id === "string" && block.id
              ? { id: block.id }
              : {}),
            ...(typeof block.name === "string" && block.name
              ? { name: block.name }
              : {}),
            ...(model ? { model } : {}),
          });
        } else if (block.type === "tool_result") {
          emit({
            type: "tool_result",
            content: resultContent(block.content),
            ...(typeof block.tool_use_id === "string" && block.tool_use_id
              ? { callId: block.tool_use_id }
              : {}),
            ...(typeof block.is_error === "boolean"
              ? { ok: !block.is_error }
              : {}),
            ...(model ? { model } : {}),
          });
        } else {
          diagnostics.push({
            code: "noise_record_dropped",
            message:
              `Skipped unsupported Cursor content block ${JSON.stringify(block.type)} ` +
              `on line ${line}.`,
            inputLine: line,
          });
        }
      }
    }

    if (recognizedRows === 0) throw invalidCursorTranscript();
    return {
      events,
      context: { source: "cursor" },
      diagnostics,
    };
  },
};

function resultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return blocksText(value);
  if (value === null || value === undefined) return "";
  return isObject(value) ? jsonString(value) : String(value);
}

function invalidCursorTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "Cursor transcript must be JSONL with role and message.content records.",
  );
}
