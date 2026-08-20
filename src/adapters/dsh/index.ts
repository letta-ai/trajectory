import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { NormalizationError } from "../../types.js";
import {
  blocksText,
  isObject,
  nonemptyString,
  parseJsonLines,
  parseTimestamp,
} from "../shared.js";

const SESSION_FORMAT_VERSION = 0;

/** Decode the logical JSONL exported by DeepSeek Harness session persistence. */
export const dshAdapter: SourceAdapter = {
  source: "dsh",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const rows = parseJsonLines(transcript, diagnostics);
    const header = rows[0]?.value;
    if (!isSessionHeader(header)) throw invalidDshTranscript();
    if (header.version !== SESSION_FORMAT_VERSION) {
      throw new NormalizationError(
        "invalid_input",
        `DeepSeek Harness session format ${String(header.version)} is unsupported; expected ${SESSION_FORMAT_VERSION}.`,
      );
    }
    if (rows.slice(1).some(({ value }) => value.type === "session")) {
      throw new NormalizationError(
        "source_group_conflict",
        "DeepSeek Harness transcript contains more than one session header.",
      );
    }

    const events: DecodedEvent[] = [];
    let modelRoute: string | undefined;

    for (const { value: record, line, byteOffset } of rows.slice(1)) {
      const data = isObject(record.data) ? record.data : {};
      if (record.type === "request/header") {
        const requestHeader = isObject(data.header) ? data.header : {};
        const config = isObject(requestHeader.config) ? requestHeader.config : {};
        modelRoute ??= routeName(config.provider, config.model);
        continue;
      }
      if (record.type === "request/context") {
        modelRoute ??= routeName(data.provider, data.model);
        continue;
      }

      const timestamp = parseTimestamp(record.time);
      const sourceSequence = safeSequence(record.seq);
      const base = {
        inputLine: line,
        ...(sourceSequence !== undefined ? { sourceSequence } : {}),
        ...(timestamp ? { timestamp } : {}),
      };

      if (record.type === "user/message") {
        if (isReplacement(record.surfaceOp)) continue;
        const message = data;
        const content = blocksText(message.content);
        if (!content) continue;
        events.push({
          type: "message",
          role: "user",
          content,
          ...base,
          ...sourceIdentity(nonemptyString(message.id), byteOffset, 0),
        });
        continue;
      }

      if (record.type === "assistant/message") {
        if (isReplacement(record.surfaceOp)) continue;
        const message = isObject(data.message) ? data.message : {};
        const source = isObject(message.source) ? message.source : {};
        const messageRoute = routeName(source.provider, source.model) ?? modelRoute;
        modelRoute ??= messageRoute;
        const messageId = nonemptyString(message.id);
        for (const [componentIndex, block] of messageBlocks(message.content).entries()) {
          if (block.type === "reasoning" && typeof block.text === "string" && block.text) {
            events.push({
              type: "reasoning",
              content: block.text,
              ...base,
              ...sourceIdentity(messageId, byteOffset, componentIndex),
              ...(messageRoute ? { model: messageRoute } : {}),
            });
          } else if (block.type === "text" && typeof block.text === "string" && block.text) {
            events.push({
              type: "message",
              role: "assistant",
              content: block.text,
              ...base,
              ...sourceIdentity(messageId, byteOffset, componentIndex),
              ...(messageRoute ? { model: messageRoute } : {}),
            });
          } else if (block.type === "image") {
            events.push({
              type: "message",
              role: "assistant",
              content: "[image]",
              ...base,
              ...sourceIdentity(messageId, byteOffset, componentIndex),
              ...(messageRoute ? { model: messageRoute } : {}),
            });
          } else if (block.type === "tool-call") {
            const id = nonemptyString(block.id);
            const name = nonemptyString(block.name);
            events.push({
              type: "tool_call",
              args: typeof block.arguments === "string" ? block.arguments : "{}",
              ...base,
              ...sourceIdentity(messageId, byteOffset, componentIndex),
              ...(id ? { id } : {}),
              ...(name ? { name } : {}),
              ...(messageRoute ? { model: messageRoute } : {}),
            });
          }
        }
        continue;
      }

      if (record.type === "tool/result") {
        if (isReplacement(record.surfaceOp)) continue;
        const message = isObject(data.message) ? data.message : {};
        const block = messageBlocks(message.content).find(
          (candidate) => candidate.type === "tool-result",
        );
        if (!block) continue;
        const source = isObject(message.source) ? message.source : {};
        const callId = nonemptyString(block.toolCallId) ?? nonemptyString(source.callId);
        const isError = typeof block.isError === "boolean"
          ? block.isError
          : isObject(data.error)
            ? true
            : undefined;
        events.push({
          type: "tool_result",
          content: blocksText(block.content),
          ...base,
          ...sourceIdentity(nonemptyString(message.id), byteOffset, 0),
          ...(callId ? { callId } : {}),
          ...(isError !== undefined ? { ok: !isError } : {}),
        });
      }
    }

    const cwd = nonemptyString(header.cwd);
    const createdAt = parseTimestamp(header.createdAt);
    return {
      events,
      context: {
        source: "dsh",
        sourceGroupId: header.id,
        ...(cwd ? { cwd } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(modelRoute ? { model: modelRoute } : {}),
      },
      diagnostics,
    };
  },
};

function isSessionHeader(value: unknown): value is Record<string, unknown> & {
  type: "session";
  version: number;
  id: string;
} {
  return isObject(value) && value.type === "session" &&
    typeof value.version === "number" && Number.isSafeInteger(value.version) &&
    typeof value.id === "string" && value.id.length > 0;
}

function safeSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function routeName(provider: unknown, model: unknown): string | undefined {
  const providerName = nonemptyString(provider);
  const modelName = nonemptyString(model);
  if (providerName && modelName) return `${providerName}/${modelName}`;
  return modelName;
}

function isReplacement(value: unknown): boolean {
  return isObject(value) && value.op === "replace";
}

function sourceIdentity(
  sourceRecordId: string | undefined,
  byteOffset: number,
  componentIndex: number,
): {
  sourceRecordId?: string;
  sourceOffset?: number;
  sourceAnchorKind?: "byte";
  componentIndex: number;
} {
  return sourceRecordId
    ? { sourceRecordId, componentIndex }
    : { sourceOffset: byteOffset, sourceAnchorKind: "byte", componentIndex };
}

function messageBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function invalidDshTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "DeepSeek Harness transcript must be logical session JSONL with one leading type=session header.",
  );
}
