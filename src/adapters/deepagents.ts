import type { DecodedEvent, DecodedSession } from "../internal.js";
import type { DeepAgentsCheckpointData } from "../types.js";
import { jsonString, parseTimestamp } from "./shared.js";

export function decodeDeepAgentsCheckpoint(
  checkpoint: DeepAgentsCheckpointData,
): DecodedSession {
  const events: DecodedEvent[] = [];
  const checkpointTimestamp = parseTimestamp(checkpoint.checkpointTimestamp);

  for (const message of checkpoint.messages) {
    const timestamp = parseTimestamp(message.timestamp) ?? checkpointTimestamp;
    if (message.role === "human") {
      if (message.content) {
        events.push({
          type: "message",
          role: "user",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
        });
      }
      continue;
    }
    if (message.role === "ai") {
      for (const reasoning of message.reasoning) {
        if (!reasoning) continue;
        events.push({
          type: "reasoning",
          content: reasoning,
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      if (message.content) {
        events.push({
          type: "message",
          role: "assistant",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      for (const call of message.toolCalls) {
        events.push({
          type: "tool_call",
          args: jsonString(call.args),
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      continue;
    }
    events.push({
      type: "tool_result",
      callId: message.toolCallId,
      content: message.content,
      ...(timestamp ? { timestamp } : {}),
    });
  }

  return {
    events,
    context: {
      source: "deepagents",
      ...(checkpoint.cwd ? { cwd: checkpoint.cwd } : {}),
      ...(checkpoint.model ? { model: checkpoint.model } : {}),
      ...(checkpointTimestamp ? { createdAt: checkpointTimestamp } : {}),
    },
    diagnostics: [],
  };
}
