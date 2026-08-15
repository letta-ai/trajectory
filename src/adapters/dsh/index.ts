import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { blocksText, isObject, jsonString, parseJsonLines, parseTimestamp } from "../shared.js";

/** Decode a decompressed DeepSeek Harness session JSONL stream. */
export const dshAdapter: SourceAdapter = {
  source: "dsh",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    let cwd: string | undefined;
    let sourceGroupId: string | undefined;
    let createdAt: Date | undefined;
    let model: string | undefined;

    for (const { value: record, line, byteOffset } of parseJsonLines(
      transcript,
      diagnostics,
    )) {
      if (record.type === "session") {
        if (!sourceGroupId) sourceGroupId = nonemptyString(record.id);
        if (!cwd) cwd = nonemptyString(record.cwd);
        if (!createdAt) createdAt = parseTimestamp(record.createdAt);
        continue;
      }

      const data = isObject(record.data) ? record.data : {};
      if (record.type === "request/header") {
        const header = isObject(data.header) ? data.header : data;
        const config = isObject(header.config) ? header.config : header;
        if (!model) model = nonemptyString(config.model);
        continue;
      }
      if (record.type === "request/context") {
        if (!model) model = nonemptyString(data.model);
        continue;
      }

      const timestamp = parseTimestamp(record.time);
      const sourceSequence = typeof record.seq === "number" ? record.seq : undefined;
      const base = {
        inputLine: line,
        ...(sourceSequence !== undefined ? { sourceSequence } : {}),
        ...(timestamp ? { timestamp } : {}),
      };
      const sourceIdentity = (
        id: string | undefined,
        componentIndex: number,
      ) =>
        id
          ? { sourceRecordId: id, componentIndex }
          : { sourceOffset: byteOffset, sourceAnchorKind: "byte" as const, componentIndex };

      if (record.type === "user/message") {
        const message = messageData(data);
        const content = blocksText(message.content);
        if (content) {
          events.push({
            type: "message",
            role: "user",
            content,
            ...base,
            ...sourceIdentity(nonemptyString(message.id), 0),
          });
        }
        continue;
      }

      if (record.type === "assistant/message") {
        const message = messageData(data);
        let componentIndex = 0;
        for (const block of messageBlocks(message.content)) {
          if (block.type === "reasoning" && typeof block.text === "string") {
            events.push({
              type: "reasoning",
              content: block.text,
              ...base,
              ...sourceIdentity(nonemptyString(message.id), componentIndex++),
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            events.push({
              type: "message",
              role: "assistant",
              content: block.text,
              ...base,
              ...sourceIdentity(nonemptyString(message.id), componentIndex++),
            });
          }
        }
        continue;
      }

      if (record.type === "tool/call") {
        const call = isObject(data.call) ? data.call : data;
        const id = nonemptyString(call.id) ?? nonemptyString(call.callId);
        const name = nonemptyString(call.name);
        events.push({
          type: "tool_call",
          args: typeof call.arguments === "string" ? call.arguments : jsonString(call.arguments),
          ...base,
          ...sourceIdentity(id, 0),
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
        });
        continue;
      }

      if (record.type === "tool/result") {
        const result = isObject(data.result) ? data.result : data;
        const message = messageData(data);
        const block = messageBlocks(message.content).find(
          (candidate) => candidate.type === "tool-result",
        );
        const callId = nonemptyString(result.id) ?? nonemptyString(result.callId) ??
          (block ? nonemptyString(block.toolCallId) : undefined);
        const isError = typeof result.error === "boolean"
          ? result.error
          : block?.isError === true;
        const content = typeof result.output === "string"
          ? result.output
          : typeof result.content === "string"
            ? result.content
            : block
              ? blocksText(block.content)
              : blocksText(message.content);
        events.push({
          type: "tool_result",
          content,
          ...base,
          ...sourceIdentity(callId, 0),
          ...(callId ? { callId } : {}),
          ...(typeof isError === "boolean" ? { ok: !isError } : {}),
        });
      }
    }

    return {
      events,
      context: {
        source: "dsh",
        ...(cwd ? { cwd } : {}),
        ...(sourceGroupId ? { sourceGroupId } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(model ? { model } : {}),
      },
      diagnostics,
    };
  },
};

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function messageData(data: Record<string, unknown>): Record<string, unknown> {
  return isObject(data.message) ? data.message : data;
}

function messageBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}
