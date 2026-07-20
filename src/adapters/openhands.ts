import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../internal.js";
import type { Diagnostic } from "../types.js";
import { NormalizationError } from "../types.js";
import {
  isObject,
  jsonString,
  parseTimestamp,
} from "./shared.js";

export const openHandsAdapter: SourceAdapter = {
  source: "openhands",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const callIdByActionId = new Map<string, string>();

    for (const event of parseEvents(transcript)) {
      if (!isObject(event) || typeof event.id !== "string" || !event.id) {
        continue;
      }
      const timestamp = parseTimestamp(event.timestamp);
      // Native identity: the OpenHands event `id`. An ActionEvent may emit a
      // reasoning component and a tool-call component sharing that id.
      const sourceRecordId = event.id;
      let componentIndex = 0;
      const emit = (decoded: DecodedEvent): void => {
        events.push({ ...decoded, sourceRecordId, componentIndex: componentIndex++ });
      };

      if (event.kind === "MessageEvent") {
        if (event.source !== "user" && event.source !== "agent") continue;
        const message = isObject(event.llm_message) ? event.llm_message : {};
        const content = joinTextContent(message.content);
        if (!content) continue;
        emit({
          type: "message",
          role: event.source === "user" ? "user" : "assistant",
          content,
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      if (event.kind === "ActionEvent") {
        const thought = joinTextContent(event.thought);
        if (thought) {
          emit({
            type: "reasoning",
            content: thought,
            ...(timestamp ? { timestamp } : {}),
          });
        }

        const callId =
          typeof event.tool_call_id === "string" && event.tool_call_id
            ? event.tool_call_id
            : `oh_${event.id}`;
        callIdByActionId.set(event.id, callId);
        emit({
          type: "tool_call",
          id: callId,
          args: actionArgsText(event),
          ...(typeof event.tool_name === "string" && event.tool_name
            ? { name: event.tool_name }
            : {}),
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      const result = extractToolResultText(event);
      if (result === undefined) continue;
      const callId =
        typeof event.tool_call_id === "string" && event.tool_call_id
          ? event.tool_call_id
          : typeof event.action_id === "string"
            ? callIdByActionId.get(event.action_id)
            : undefined;
      emit({
        type: "tool_result",
        content: result,
        ...(callId ? { callId } : {}),
        ...(timestamp ? { timestamp } : {}),
      });
    }

    return {
      events,
      context: { source: "openhands" },
      diagnostics,
    };
  },
};

function parseEvents(transcript: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw new NormalizationError(
      "invalid_input",
      "OpenHands transcript must be a JSON event array or an object with an items array.",
    );
  }
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.items)) return parsed.items;
  throw new NormalizationError(
    "invalid_input",
    "OpenHands transcript must be a JSON event array or an object with an items array.",
  );
}

function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (
      isObject(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

function actionArgsText(event: Record<string, unknown>): string {
  if (isObject(event.tool_call)) {
    const raw = event.tool_call.arguments;
    if (typeof raw === "string" && raw) return raw;
  }
  if (isObject(event.action)) {
    const args = { ...event.action };
    delete args.kind;
    return jsonString(args);
  }
  return "{}";
}

function extractToolResultText(
  event: Record<string, unknown>,
): string | undefined {
  if (event.kind === "ObservationEvent") {
    const observation = isObject(event.observation) ? event.observation : {};
    return joinTextContent(observation.content);
  }
  if (event.kind === "AgentErrorEvent") {
    return typeof event.error === "string" ? event.error : "";
  }
  if (event.kind === "UserRejectObservation") {
    return typeof event.rejection_reason === "string"
      ? event.rejection_reason
      : "";
  }
  return undefined;
}
