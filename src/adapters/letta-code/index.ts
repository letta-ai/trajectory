import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { NormalizationError } from "../../types.js";
import { parseJsonLines, parseTimestamp } from "../shared.js";

const SUPPORTED_KINDS = new Set([
  "user",
  "assistant",
  "reasoning",
  "tool_call",
  "error",
]);

export const lettaCodeAdapter: SourceAdapter = {
  source: "letta-code",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const rows = parseJsonLines(transcript, diagnostics);
    const events: DecodedEvent[] = [];
    const reasoningRecordIds = new Set<string>();
    let recognizedRows = 0;

    for (const { value: row } of rows) {
      if (row.kind !== "reasoning") continue;
      const sourceRecordId =
        nonemptyString(row.source_message_id) ??
        nonemptyString(row.source_line_id);
      if (sourceRecordId) reasoningRecordIds.add(sourceRecordId);
    }

    for (const { value: row, line } of rows) {
      if (typeof row.kind !== "string" || !SUPPORTED_KINDS.has(row.kind)) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Letta Code transcript row on line ${line}.`,
          inputLine: line,
        });
        continue;
      }
      recognizedRows += 1;

      if (row.kind === "error") {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped Letta Code runtime error row on line ${line}.`,
          inputLine: line,
        });
        continue;
      }

      const timestamp = parseTimestamp(row.captured_at);
      const sourceMessageId = nonemptyString(row.source_message_id);
      const sourceLineId = nonemptyString(row.source_line_id);
      const sourceRecordId = sourceMessageId ?? sourceLineId;
      const sourceFields = sourceRecordId
        ? { sourceRecordId }
        : {
            sourceOffset: line - 1,
            sourceAnchorKind: "ordinal" as const,
          };

      if (
        row.kind === "user" ||
        row.kind === "assistant" ||
        row.kind === "reasoning"
      ) {
        if (typeof row.text !== "string" || row.text.length === 0) {
          diagnostics.push({
            code: "noise_record_dropped",
            message: `Skipped empty Letta Code ${row.kind} row on line ${line}.`,
            inputLine: line,
          });
          continue;
        }
        const componentIndex =
          row.kind === "assistant" &&
          sourceRecordId !== undefined &&
          reasoningRecordIds.has(sourceRecordId)
            ? 1
            : 0;
        if (row.kind === "reasoning") {
          events.push({
            type: "reasoning",
            content: row.text,
            inputLine: line,
            ...sourceFields,
            componentIndex,
            ...(timestamp ? { timestamp } : {}),
          });
        } else {
          events.push({
            type: "message",
            role: row.kind,
            content: row.text,
            inputLine: line,
            ...sourceFields,
            componentIndex,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      // Older client rows can lack both source ids. The generated value exists
      // only to link the call/result emitted from this one row; source identity
      // still follows source_message_id ?? source_line_id and otherwise uses the
      // row position assigned above.
      const callId =
        sourceLineId ?? sourceMessageId ?? `letta-code-tool-line-${line}`;
      const name = nonemptyString(row.name);
      events.push({
        type: "tool_call",
        args: nonemptyString(row.argsText) ?? "{}",
        inputLine: line,
        ...sourceFields,
        componentIndex: 0,
        id: callId,
        ...(name ? { name } : {}),
        ...(timestamp ? { timestamp } : {}),
      });

      if (
        typeof row.resultText === "string" ||
        typeof row.resultOk === "boolean"
      ) {
        let content = typeof row.resultText === "string" ? row.resultText : "";
        if (row.resultOk === false && !/^error/i.test(content)) {
          content = `Error: ${content}`;
        }
        events.push({
          type: "tool_result",
          content,
          ...(typeof row.resultOk === "boolean" ? { ok: row.resultOk } : {}),
          inputLine: line,
          ...sourceFields,
          componentIndex: 1,
          callId,
          ...(timestamp ? { timestamp } : {}),
        });
      }
    }

    if (recognizedRows === 0) {
      throw invalidLettaCodeTranscript();
    }

    return {
      events,
      context: { source: "letta-code" },
      diagnostics,
    };
  },
};

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invalidLettaCodeTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "Letta Code transcript must be client-side transcript.jsonl with kind-tagged rows.",
  );
}
