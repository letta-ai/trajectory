import type { DecodedEvent, DecodedSession } from "../internal.js";
import type { DeepAgentsCheckpointData } from "../types.js";
import { jsonString, parseTimestamp } from "./shared.js";

export function decodeDeepAgentsCheckpoint(
  checkpoint: DeepAgentsCheckpointData,
): DecodedSession {
  const events: DecodedEvent[] = [];
  const checkpointTimestamp = parseTimestamp(checkpoint.checkpointTimestamp);

  checkpoint.messages.forEach((message, offset) => {
    const timestamp = parseTimestamp(message.timestamp) ?? checkpointTimestamp;
    // Deep Agents messages carry no native per-message id, so identity is
    // anchored to the message offset within the checkpoint (kind `location`).
    let componentIndex = 0;
    const emit = (event: DecodedEvent): void => {
      events.push({
        ...event,
        sourceOffset: offset,
        sourceAnchorKind: "ordinal",
        componentIndex: componentIndex++,
      });
    };

    if (message.role === "human") {
      if (message.content) {
        emit({
          type: "message",
          role: "user",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
        });
      }
      return;
    }
    if (message.role === "ai") {
      for (const reasoning of message.reasoning) {
        if (!reasoning) continue;
        emit({
          type: "reasoning",
          content: reasoning,
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      if (message.content) {
        emit({
          type: "message",
          role: "assistant",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      for (const call of message.toolCalls) {
        emit({
          type: "tool_call",
          args: jsonString(call.args),
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      return;
    }
    emit({
      type: "tool_result",
      callId: message.toolCallId,
      content: message.content,
      ...(timestamp ? { timestamp } : {}),
    });
  });

  return {
    events,
    context: {
      source: "deepagents",
      ...(checkpoint.cwd ? { cwd: checkpoint.cwd } : {}),
      ...(checkpoint.model ? { model: checkpoint.model } : {}),
      ...(checkpointTimestamp ? { createdAt: checkpointTimestamp } : {}),
      sourceGroupId: deepAgentsGroupId(
        checkpoint.threadId,
        checkpoint.checkpointNamespace,
      ),
    },
    diagnostics: [],
  };
}

/**
 * Group identity for a Deep Agents checkpoint. Different namespaces are distinct
 * checkpoint streams whose offset-derived identities would otherwise collide, so
 * the group uniquely encodes the `(threadId, checkpointNamespace)` pair. The pair
 * is encoded uniformly for every namespace (including root) so no thread id whose
 * literal value looks like the encoding can collide with a real pair.
 */
function deepAgentsGroupId(threadId: string, checkpointNamespace: string): string {
  return JSON.stringify([threadId, checkpointNamespace]);
}
