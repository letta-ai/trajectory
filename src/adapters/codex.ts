import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../internal.js";
import type { Diagnostic } from "../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseJsonLines,
  parseTimestamp,
} from "./shared.js";

const INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
  "<turn_context>",
];

export const codexAdapter: SourceAdapter = {
  source: "codex",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let createdAt: Date | undefined;
    let sessionId: string | undefined;

    for (const { value: record, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
      const recordType = record.type;
      const payload = isObject(record.payload) ? record.payload : {};
      const timestamp = parseTimestamp(record.timestamp);
      const payloadType = payload.type;
      // Codex rollout lines carry no per-record id, so the append-only byte
      // offset is the stable location anchor for identity (kind `location`).
      // The worker adds sourceContext.baseByteOffset to anchor it absolutely
      // across chunked uploads.
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: 0,
        });
      };

      if (recordType === "session_meta") {
        if (!cwd && typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
        createdAt ??= parseTimestamp(payload.timestamp) ?? timestamp;
        if (!gitBranch && isObject(payload.git) && typeof payload.git.branch === "string") {
          gitBranch = payload.git.branch;
        }
        if (!sessionId && typeof payload.id === "string" && payload.id) {
          sessionId = payload.id;
        }
        continue;
      }

      if (recordType === "turn_context") {
        if (!cwd && typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
        if (!model && typeof payload.model === "string" && payload.model) {
          model = payload.model;
        }
        continue;
      }

      if (recordType === "event_msg") {
        if (
          payloadType === "agent_reasoning" &&
          typeof payload.text === "string" &&
          payload.text.trim()
        ) {
          emit({
            type: "reasoning",
            content: payload.text,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (recordType !== "response_item") continue;

      if (payloadType === "message") {
        const role = payload.role;
        const content = blocksText(payload.content);
        if (role === "user") {
          const head = content.trimStart();
          if (INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) {
            diagnostics.push({
              code: "injected_context_dropped",
              message: `Dropped Codex system-injected user content on line ${line}.`,
              inputLine: line,
            });
          } else {
            emit({
              type: "message",
              role: "user",
              content,
              inputLine: line,
              ...(timestamp ? { timestamp } : {}),
            });
          }
        } else if (role === "assistant") {
          emit({
            type: "message",
            role: "assistant",
            content,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (payloadType === "function_call") {
        emit({
          type: "tool_call",
          args:
            typeof payload.arguments === "string" && payload.arguments
              ? payload.arguments
              : "{}",
          inputLine: line,
          ...(typeof payload.call_id === "string" ? { id: payload.call_id } : {}),
          ...(typeof payload.name === "string" ? { name: payload.name } : {}),
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      if (payloadType === "custom_tool_call") {
        emit({
          type: "tool_call",
          args: jsonString({ input: payload.input ?? "" }),
          inputLine: line,
          ...(typeof payload.call_id === "string" ? { id: payload.call_id } : {}),
          ...(typeof payload.name === "string" ? { name: payload.name } : {}),
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      if (payloadType === "web_search_call") {
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload)) {
          if (key !== "type" && key !== "call_id" && key !== "status") {
            args[key] = value;
          }
        }
        emit({
          type: "tool_call",
          name: "web_search",
          args: jsonString(args),
          inputLine: line,
          ...(typeof payload.call_id === "string" ? { id: payload.call_id } : {}),
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      if (payloadType === "tool_search_call") {
        emit({
          type: "tool_call",
          name: "tool_search",
          args:
            typeof payload.arguments === "string" && payload.arguments
              ? payload.arguments
              : jsonString(payload.arguments),
          inputLine: line,
          ...(typeof payload.call_id === "string" ? { id: payload.call_id } : {}),
          ...(timestamp ? { timestamp } : {}),
        });
        continue;
      }

      if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output" ||
        payloadType === "tool_search_output"
      ) {
        emit({
          type: "tool_result",
          content:
            payloadType === "tool_search_output"
              ? jsonString(payload.tools ?? [])
              : outputText(payload.output),
          inputLine: line,
          ...(typeof payload.call_id === "string" ? { callId: payload.call_id } : {}),
          ...(timestamp ? { timestamp } : {}),
        });
      }
    }

    return {
      events,
      context: {
        source: "codex",
        ...(cwd ? { cwd } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(model ? { model } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(sessionId ? { sourceGroupId: sessionId } : {}),
      },
      diagnostics,
    };
  },
};

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return blocksText(output) || jsonString(output);
  if (isObject(output)) {
    return typeof output.content === "string" && output.content
      ? output.content
      : jsonString(output);
  }
  return output == null ? "" : String(output);
}
