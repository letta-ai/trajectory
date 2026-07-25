import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { isObject, jsonString, parseJsonLines } from "../shared.js";

const TRANSPORT_TYPES = new Set([
  "todo_state",
  "session_end",
  "compaction_state",
]);

/** Decode Droid's Anthropic-style JSONL session export. */
export const droidAdapter: SourceAdapter = {
  source: "droid",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    let cwd: string | undefined;
    let sourceGroupId: string | undefined;

    for (const { value: record, line, byteOffset } of parseJsonLines(
      transcript,
      diagnostics,
    )) {
      const recordType = record.type;
      if (recordType === "session_start") {
        // The session_start header is first in native files. Keep the first
        // observed header if a malformed export happens to contain another.
        if (sourceGroupId === undefined && typeof record.id === "string" && record.id) {
          sourceGroupId = record.id;
        }
        if (cwd === undefined && typeof record.cwd === "string" && record.cwd) {
          cwd = record.cwd;
        }
        continue;
      }
      if (typeof recordType === "string" && TRANSPORT_TYPES.has(recordType)) {
        continue;
      }
      if (recordType !== "message" || !isObject(record.message)) continue;

      const role = record.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const blocks = record.message.content;
      if (!Array.isArray(blocks)) continue;

      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: componentIndex++,
        });
      };

      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === "thinking") {
          emit({
            type: "reasoning",
            content: typeof block.thinking === "string" ? block.thinking : "",
            inputLine: line,
          });
        } else if (block.type === "text") {
          emit({
            type: "message",
            role,
            content: typeof block.text === "string" ? block.text : "",
            inputLine: line,
          });
        } else if (block.type === "tool_use" && role === "assistant") {
          emit({
            type: "tool_call",
            args: jsonString(block.input),
            inputLine: line,
            ...(typeof block.id === "string" && block.id ? { id: block.id } : {}),
            ...(typeof block.name === "string" && block.name
              ? { name: block.name }
              : {}),
          });
        } else if (block.type === "tool_result" && role === "user") {
          emit({
            type: "tool_result",
            content:
              typeof block.content === "string" ? block.content : String(block.content),
            inputLine: line,
            ...(typeof block.tool_use_id === "string" && block.tool_use_id
              ? { callId: block.tool_use_id }
              : {}),
          });
        }
      }
    }

    return {
      events,
      context: {
        source: "droid",
        ...(cwd ? { cwd } : {}),
        ...(sourceGroupId ? { sourceGroupId } : {}),
      },
      diagnostics,
    };
  },
};
