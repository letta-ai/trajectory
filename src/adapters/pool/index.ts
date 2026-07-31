import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import { NormalizationError } from "../../types.js";
import type { Diagnostic } from "../../types.js";
import {
  isObject,
  parseTimestamp,
  jsonString,
  parseJsonLines,
} from "../shared.js";

/**
 * Pool (poolside) native transcript adapter.
 *
 * Pool writes one JSON object per line to
 * `~/.local/state/poolside/trajectories/trajectory-standalone_<session-id>.ndjson`.
 * Every event carries a top-level native UUID (`id`), a `step_id`, an ISO
 * `timestamp`, and a `type`. The adapter maps the conversational event types
 * to the shared internal contract and treats the remaining types
 * (`session.input` payload wrappers, `thought.start`, `assistant_message.start`,
 * `tool_call.start`, `tool_call.approval`, `model_reminder`, and the full
 * `tool_call.inference.start` request) as transport/marker/noise that is
 * skipped silently, matching how other adapters drop transport rows.
 *
 * Identity model:
 * - Every body record is anchored to its native event UUID (`sourceRecordId`),
 *   so identity is `native` and independent of transport-arrival order.
 * - Tool calls and results are linked by the native call id shared between
 *   `tool_call_parsed.id` and `tool_call_result.id` (not by the event UUID).
 * - The leading `session.start` record id anchors the source group; a file
 *   with more than one distinct session-start id is flagged ambiguous so
 *   canonical callers must supply `sourceContext.groupId` (mirrors Claude
 *   Code resumed exports).
 * - Tool-result success is projected only from the native `is_error` boolean
 *   when present (`ok = !is_error`); it is omitted otherwise and never inferred
 *   from result text.
 */
export const poolAdapter: SourceAdapter = {
  source: "pool",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const lines = parseJsonLines(transcript, diagnostics);

    let cwd: string | undefined;
    let model: string | undefined;
    let createdAt: Date | undefined;
    const sessionStartIds = new Set<string>();
    let seenMessageRow = false;

    for (const { value: event, line } of lines) {
      if (!isObject(event) || typeof event.type !== "string") continue;
      const type = event.type;
      const timestamp = parseTimestamp(event.timestamp);
      // Native per-event identity: every Pool event carries a UUID `id`.
      const sourceRecordId =
        typeof event.id === "string" && event.id ? event.id : undefined;

      if (type === "session.start") {
        if (typeof event.id === "string" && event.id) {
          seenMessageRow = true;
          sessionStartIds.add(event.id);
        }
        const sessionStart = isObject(event.session_start)
          ? event.session_start
          : {};
        if (!cwd && poolFirstString(sessionStart.working_directories)) {
          cwd = poolFirstString(sessionStart.working_directories)!;
        }
        if (
          !cwd &&
          typeof sessionStart.workspace === "string" &&
          sessionStart.workspace
        ) {
          cwd = sessionStart.workspace;
        }
        createdAt ??= timestamp;
        continue;
      }

      if (type === "session.input") {
        seenMessageRow = true;
        const sessionInput = isObject(event.session_input) ? event.session_input : {};
        const prompt = toStringValue(sessionInput.prompt);
        if (prompt && prompt.trim()) {
          events.push({
            type: "message",
            role: "user",
            content: prompt,
            ...(sourceRecordId ? { sourceRecordId } : {}),
            ...(timestamp ? { timestamp } : {}),
            inputLine: line,
          });
        }
        continue;
      }

      // The inference-start event embeds the whole chat-completion request
      // (system prompt, message history, tools). Harvest only the model id;
      // the rest is transport noise, skipped like other sources' UI rows.
      if (type === "tool_call.inference.start") {
        const inference = isObject(event.tool_call_inference_start)
          ? event.tool_call_inference_start
          : {};
        const request = isObject(inference.chat_completion_request)
          ? inference.chat_completion_request
          : {};
        if (!model && typeof request.model === "string" && request.model) {
          model = request.model;
        }
        continue;
      }

      if (type === "thought.end") {
        const thoughtEnd = isObject(event.thought_end) ? event.thought_end : {};
        const content = toStringValue(thoughtEnd.thought);
        if (content && content.trim()) {
          events.push({
            type: "reasoning",
            content,
            ...(sourceRecordId ? { sourceRecordId } : {}),
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
            inputLine: line,
          });
        }
        continue;
      }

      if (type === "assistant_message.end") {
        const messageEnd = isObject(event.assistant_message_end)
          ? event.assistant_message_end
          : {};
        const content = toStringValue(messageEnd.assistant_message);
        if (content && content.trim()) {
          events.push({
            type: "message",
            role: "assistant",
            content,
            ...(sourceRecordId ? { sourceRecordId } : {}),
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
            inputLine: line,
          });
        }
        continue;
      }

      if (type === "tool_call.parsed") {
        seenMessageRow = true;
        const parsed = isObject(event.tool_call_parsed)
          ? event.tool_call_parsed
          : {};
        const callId =
          typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
        const name =
          typeof parsed.name === "string" && parsed.name ? parsed.name : undefined;
        const rawArgs =
          typeof parsed.raw_args === "string" && parsed.raw_args
            ? parsed.raw_args
            : jsonString(parsed.args ?? {});
        events.push({
          type: "tool_call",
          ...(callId ? { id: callId } : {}),
          ...(name ? { name } : {}),
          args: rawArgs,
          ...(sourceRecordId ? { sourceRecordId } : {}),
          ...(timestamp ? { timestamp } : {}),
          inputLine: line,
        });
        continue;
      }

      if (type === "tool_call.result") {
        const result = isObject(event.tool_call_result)
          ? event.tool_call_result
          : {};
        const callId =
          typeof result.id === "string" && result.id ? result.id : undefined;
        const content =
          typeof result.observation === "string" ? result.observation : "";
        const ok =
          typeof result.is_error === "boolean" ? !result.is_error : undefined;
        events.push({
          type: "tool_result",
          ...(callId ? { callId } : {}),
          content,
          ...(ok !== undefined ? { ok } : {}),
          ...(sourceRecordId ? { sourceRecordId } : {}),
          ...(timestamp ? { timestamp } : {}),
          inputLine: line,
        });
        continue;
      }

      // Remaining types are markers/payload wrappers/noise:
      //   thought.start, assistant_message.start, tool_call.start,
      //   tool_call.approval, model_reminder, session.input (without prompt),
      //   any other type
      // They carry no conversational record; skip silently, as other adapters
      // skip transport/UI rows.
    }

    if (!seenMessageRow) {
      throw new NormalizationError(
        "invalid_input",
        "Pool transcript must be session JSONL containing a session.start header and message entries.",
      );
    }

    const sourceGroupId = resolveGroupId(sessionStartIds);

    return {
      events,
      context: {
        source: "pool",
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(sourceGroupId
          ? { sourceGroupId, sourceGroupAmbiguous: sessionStartIds.size > 1 }
          : {}),
      },
      diagnostics,
    };
  },
};

function poolFirstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item) return item;
    }
  }
  return undefined;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A single distinct `session.start` id becomes the native source group so a
 * complete file does not require caller-supplied context. Multiple distinct
 * session-start ids (a resumed/concatenated export) surface ambiguity; canonical
 * callers then pass `sourceContext.groupId`, mirroring Claude Code.
 */
function resolveGroupId(sessionStartIds: Set<string>): string | undefined {
  if (sessionStartIds.size === 1) {
    return [...sessionStartIds][0]!;
  }
  return undefined;
}
