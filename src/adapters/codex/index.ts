import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseJsonLines,
  parseTimestamp,
} from "../shared.js";
import type { JsonLine } from "../shared.js";

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

    const lines = parseJsonLines(transcript, diagnostics);
    const agentReasoning = agentReasoningTexts(lines);

    for (const { value: record, line, byteOffset } of lines) {
      const recordType = record.type;
      const payload = isObject(record.payload) ? record.payload : {};
      const timestamp = parseTimestamp(record.timestamp);
      const payloadType = payload.type;
      // Codex rollout lines carry no per-record id, so the append-only byte
      // offset is the stable location anchor for identity (kind `location`).
      // The worker adds sourceContext.baseByteOffset to anchor it absolutely
      // across chunked uploads.
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: componentIndex++,
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

      if (payloadType === "reasoning") {
        for (const text of reasoningSummaries(payload.summary)) {
          // Older writers also emit each summary as an `agent_reasoning`
          // event, which is already decoded above.
          const key = text.trim();
          const repeats = agentReasoning.get(key) ?? 0;
          if (repeats > 0) {
            agentReasoning.set(key, repeats - 1);
            continue;
          }
          emit({
            type: "reasoning",
            content: text,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (payloadType === "message") {
        const role = payload.role;
        const content = blocksText(payload.content);
        if (role === "system") {
          emit({
            type: "message",
            role: "system",
            content,
            inputLine: line,
            ...(timestamp ? { timestamp } : {}),
          });
        } else if (role === "user") {
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

/**
 * Counts `agent_reasoning` event texts. Writers that emit these events also
 * store the same text as `response_item` reasoning summaries; newer writers
 * store only the summaries.
 */
function agentReasoningTexts(lines: JsonLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { value } of lines) {
    if (value.type !== "event_msg" || !isObject(value.payload)) continue;
    const { type, text } = value.payload;
    if (type !== "agent_reasoning" || typeof text !== "string") continue;
    const key = text.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function reasoningSummaries(summary: unknown): string[] {
  if (!Array.isArray(summary)) return [];
  return summary.flatMap((part) =>
    isObject(part) && typeof part.text === "string" && part.text.trim()
      ? [part.text]
      : [],
  );
}

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
