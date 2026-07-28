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
  parseJsonLines,
  parseTimestamp,
} from "../shared.js";

const KNOWN_EVENT_TYPES = new Set([
  "abort",
  "assistant.message",
  "assistant.turn_end",
  "assistant.turn_start",
  "hook.end",
  "hook.start",
  "session.compaction_complete",
  "session.compaction_start",
  "session.info",
  "session.mode_changed",
  "session.model_change",
  "session.plan_changed",
  "session.resume",
  "session.shutdown",
  "session.start",
  "session.task_complete",
  "system.notification",
  "tool.execution_complete",
  "tool.execution_start",
  "user.message",
]);

/** Decode the event JSONL emitted by GitHub Copilot CLI. */
export const copilotCliAdapter: SourceAdapter = {
  source: "copilot-cli",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const rows = parseJsonLines(transcript, diagnostics);
    const events: DecodedEvent[] = [];
    let recognizedRows = 0;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let sourceGroupId: string | undefined;
    let createdAt: Date | undefined;

    // Resolve session context independently of where the relevant transport
    // event appears in the exported stream.
    for (const { value: row } of rows) {
      if (typeof row.type !== "string" || !KNOWN_EVENT_TYPES.has(row.type)) continue;
      const data = isObject(row.data) ? row.data : {};
      if (row.type === "session.start") {
        sourceGroupId ??= nonemptyString(data.sessionId);
        createdAt ??= parseTimestamp(data.startTime);
        const context = isObject(data.context) ? data.context : {};
        cwd ??= nonemptyString(context.cwd);
        gitBranch ??= nonemptyString(context.branch);
      } else if (
        row.type === "hook.start" &&
        data.hookType === "userPromptSubmitted"
      ) {
        const input = isObject(data.input) ? data.input : {};
        sourceGroupId ??= nonemptyString(input.sessionId);
        cwd ??= nonemptyString(input.cwd);
      } else if (row.type === "tool.execution_complete") {
        model ??= nonemptyString(data.model);
      } else if (row.type === "session.model_change") {
        model ??= nonemptyString(data.newModel);
      } else if (row.type === "session.shutdown") {
        model ??= nonemptyString(data.currentModel);
      }
    }

    for (const { value: row, line, byteOffset } of rows) {
      const rowType = row.type;
      if (typeof rowType !== "string" || !KNOWN_EVENT_TYPES.has(rowType)) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Copilot CLI event on line ${line}.`,
          inputLine: line,
        });
        continue;
      }
      recognizedRows += 1;
      const data = isObject(row.data) ? row.data : {};
      const timestamp = parseTimestamp(row.timestamp);
      const sourceRecordId = nonemptyString(row.id);
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

      if (
        rowType === "hook.start" &&
        data.hookType === "userPromptSubmitted"
      ) {
        const input = isObject(data.input) ? data.input : {};
        const promptTimestamp = parseTimestamp(input.timestamp) ?? timestamp;
        emit({
          type: "message",
          role: "user",
          content: typeof input.prompt === "string" ? input.prompt : "",
          ...(promptTimestamp ? { timestamp: promptTimestamp } : {}),
        });
        continue;
      }

      if (rowType === "assistant.message") {
        const eventModel = nonemptyString(data.model);
        if (typeof data.reasoningText === "string" && data.reasoningText.trim()) {
          emit({
            type: "reasoning",
            content: data.reasoningText,
            ...(timestamp ? { timestamp } : {}),
            ...(eventModel ? { model: eventModel } : {}),
          });
        }
        if (typeof data.content === "string" && data.content.trim()) {
          emit({
            type: "message",
            role: "assistant",
            content: data.content,
            ...(timestamp ? { timestamp } : {}),
            ...(eventModel ? { model: eventModel } : {}),
          });
        }
        if (Array.isArray(data.toolRequests)) {
          for (const request of data.toolRequests) {
            if (!isObject(request)) continue;
            const callId = nonemptyString(request.toolCallId);
            const name = nonemptyString(request.name);
            emit({
              type: "tool_call",
              args:
                typeof request.arguments === "string"
                  ? request.arguments
                  : jsonString(request.arguments),
              ...(callId ? { id: callId } : {}),
              ...(name ? { name } : {}),
              ...(timestamp ? { timestamp } : {}),
              ...(eventModel ? { model: eventModel } : {}),
            });
          }
        }
        continue;
      }

      if (rowType === "tool.execution_complete") {
        const callId = nonemptyString(data.toolCallId);
        const eventModel = nonemptyString(data.model);
        emit({
          type: "tool_result",
          content: copilotResultContent(data),
          ...(callId ? { callId } : {}),
          ...(typeof data.success === "boolean" ? { ok: data.success } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(eventModel ? { model: eventModel } : {}),
        });
      }
      // user.message duplicates the userPromptSubmitted hook. Turn, session,
      // hook-end, execution-start, notification, and lifecycle events are
      // transport/state records rather than model-context records.
    }

    if (recognizedRows === 0) throw invalidCopilotTranscript();
    return {
      events,
      context: {
        source: "copilot-cli",
        ...(cwd ? { cwd } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(model ? { model } : {}),
        ...(sourceGroupId ? { sourceGroupId } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      diagnostics,
    };
  },
};

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function copilotResultContent(data: Record<string, unknown>): string {
  if (isObject(data.result)) {
    const content = data.result.content;
    if (typeof content === "string") return content;
    if (content !== undefined) return stringifyContent(content);
  }
  if (isObject(data.error) && typeof data.error.message === "string") {
    return data.error.message;
  }
  if (data.error !== undefined) return stringifyContent(data.error);
  return "";
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return isObject(value) || Array.isArray(value) ? jsonString(value) : String(value);
}

function invalidCopilotTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "Copilot CLI transcript must be native event JSONL with recognized type and data records.",
  );
}
