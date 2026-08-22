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
  nonemptyString,
  parseTimestamp,
} from "../shared.js";

const TERMINAL_TOOL_STATUSES = new Set(["done", "error", "cancelled"]);

export const ampAdapter: SourceAdapter = {
  source: "amp",

  decode(transcript: string): DecodedSession {
    const root = parseExport(transcript);
    const sourceGroupId = nonemptyString(root.id);
    if (!sourceGroupId) invalid("Amp thread export must contain a non-empty root id.");
    if (!Array.isArray(root.messages)) {
      invalid("Amp thread export must contain a messages array.");
    }

    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const messageIds = new Set<number>();
    const protocolMessageIds = new Set<string>();
    const toolCallIds = new Set<string>();
    const terminalResultIds = new Set<string>();
    const nonterminalResultIds = new Set<string>();
    let lastConversationalRole: "user" | "assistant" | undefined;

    for (let messageIndex = 0; messageIndex < root.messages.length; messageIndex += 1) {
      const message = root.messages[messageIndex];
      if (!isObject(message)) invalid(`Amp message ${messageIndex} must be an object.`);

      const messageId = message.messageId;
      if (!Number.isSafeInteger(messageId) || (messageId as number) < 0) {
        invalid(`Amp message ${messageIndex} must have a non-negative integer messageId.`);
      }
      if (messageIds.has(messageId as number)) {
        invalid(`Amp thread export contains duplicate messageId at message ${messageIndex}.`);
      }
      messageIds.add(messageId as number);

      const sourceRecordId = nonemptyString(message.protocolMessageID);
      if (!sourceRecordId) {
        invalid(`Amp message ${messageIndex} must have a non-empty protocolMessageID.`);
      }
      if (protocolMessageIds.has(sourceRecordId)) {
        invalid(
          `Amp thread export contains duplicate protocolMessageID at message ${messageIndex}.`,
        );
      }
      protocolMessageIds.add(sourceRecordId);

      if (!Array.isArray(message.content)) {
        invalid(`Amp message ${messageIndex} must contain a content array.`);
      }
      if (message.role === "info") {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Dropped an Amp info record at message ${messageIndex}.`,
          count: 1,
        });
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        invalid(`Amp message ${messageIndex} has an unsupported semantic role.`);
      }
      lastConversationalRole = message.role;

      if (message.role === "user") {
        const timestamp = parseTimestamp(isObject(message.meta) ? message.meta.sentAt : undefined);
        for (let componentIndex = 0; componentIndex < message.content.length; componentIndex += 1) {
          const block = message.content[componentIndex];
          if (!isObject(block)) {
            invalid(`Amp user block ${messageIndex}:${componentIndex} must be an object.`);
          }
          if (block.type === "text") {
            if (typeof block.text !== "string") {
              invalid(`Amp text block ${messageIndex}:${componentIndex} must contain text.`);
            }
            events.push({
              type: "message",
              role: "user",
              content: block.text,
              ...(timestamp ? { timestamp } : {}),
              sourceRecordId,
              sourceSequence: messageIndex,
              componentIndex,
            });
            continue;
          }
          if (block.type !== "tool_result") {
            invalid(`Amp user block ${messageIndex}:${componentIndex} has an unsupported type.`);
          }

          const callId = nonemptyString(block.toolUseID);
          if (!callId || !isObject(block.run) || typeof block.run.status !== "string") {
            invalid(`Amp tool result ${messageIndex}:${componentIndex} is malformed.`);
          }
          if (!TERMINAL_TOOL_STATUSES.has(block.run.status)) {
            nonterminalResultIds.add(callId);
            diagnostics.push({
              code: "incomplete_transcript",
              message: `Amp tool result at message ${messageIndex} is not terminal.`,
              count: 1,
            });
            continue;
          }
          terminalResultIds.add(callId);
          events.push({
            type: "tool_result",
            callId,
            content: resultText(block.run.result),
            ok: block.run.status === "done",
            ...(timestamp ? { timestamp } : {}),
            sourceRecordId,
            sourceSequence: messageIndex,
            componentIndex,
          });
        }
        continue;
      }

      const messageComplete =
        isObject(message.state) && message.state.type === "complete";
      if (!messageComplete) {
        diagnostics.push({
          code: "incomplete_transcript",
          message: `Amp assistant turn at message ${messageIndex} is not complete.`,
          count: 1,
        });
      }
      const fallbackTimestamp = parseTimestamp(
        isObject(message.usage) ? message.usage.timestamp : undefined,
      );
      const model = nonemptyString(isObject(message.usage) ? message.usage.model : undefined);

      for (let componentIndex = 0; componentIndex < message.content.length; componentIndex += 1) {
        const block = message.content[componentIndex];
        if (!isObject(block)) {
          invalid(`Amp assistant block ${messageIndex}:${componentIndex} must be an object.`);
        }
        if (block.type !== "text" && block.type !== "thinking" && block.type !== "tool_use") {
          invalid(`Amp assistant block ${messageIndex}:${componentIndex} has an unsupported type.`);
        }
        const blockComplete =
          block.blockState === "complete" &&
          (block.type !== "tool_use" || block.complete === true);
        if (!blockComplete) {
          diagnostics.push({
            code: "incomplete_transcript",
            message: `Amp assistant block ${messageIndex}:${componentIndex} is not complete.`,
            count: 1,
          });
          continue;
        }

        const timestamp =
          parseTimestamp(block.startTime) ?? parseTimestamp(block.finalTime) ?? fallbackTimestamp;
        const shared = {
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
          sourceRecordId,
          sourceSequence: messageIndex,
          componentIndex,
        };
        if (block.type === "text") {
          if (typeof block.text !== "string") {
            invalid(`Amp text block ${messageIndex}:${componentIndex} must contain text.`);
          }
          events.push({ type: "message", role: "assistant", content: block.text, ...shared });
        } else if (block.type === "thinking") {
          if (typeof block.thinking !== "string") {
            invalid(`Amp thinking block ${messageIndex}:${componentIndex} must contain thinking.`);
          }
          events.push({ type: "reasoning", content: block.thinking, ...shared });
        } else {
          const callId = nonemptyString(block.id);
          if (!callId) {
            invalid(`Amp tool use ${messageIndex}:${componentIndex} must contain an id.`);
          }
          const name = nonemptyString(block.name);
          toolCallIds.add(callId);
          events.push({
            type: "tool_call",
            id: callId,
            ...(name ? { name } : {}),
            args: jsonString(block.input),
            ...shared,
          });
        }
      }
    }

    for (const callId of toolCallIds) {
      if (!terminalResultIds.has(callId) && !nonterminalResultIds.has(callId)) {
        diagnostics.push({
          code: "incomplete_transcript",
          message: "Amp thread export contains a tool call without a result.",
          count: 1,
        });
      }
    }
    if (lastConversationalRole === "user") {
      diagnostics.push({
        code: "incomplete_transcript",
        message: "Amp thread export ends with an unmatched user turn.",
        count: 1,
      });
    }

    const initial = isObject(root.env) && isObject(root.env.initial) ? root.env.initial : undefined;
    const cwd = nonemptyString(initial?.workingDirectory);
    const gitBranch = singleTreeRef(initial?.trees);
    const createdAt = parseTimestamp(root.created);

    return {
      events,
      context: {
        source: "amp",
        sourceGroupId,
        sourceSequencePrimary: true,
        ...(cwd ? { cwd } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      diagnostics,
    };
  },
};

function parseExport(transcript: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    invalid("Amp thread export must be one complete JSON object.");
  }
  if (!isObject(parsed)) invalid("Amp thread export must be a JSON object.");
  return parsed;
}

function resultText(result: unknown): string {
  return typeof result === "string" ? result : jsonString(result);
}

function singleTreeRef(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1 || !isObject(value[0])) return undefined;
  const repository = value[0].repository;
  return isObject(repository) ? nonemptyString(repository.ref) : undefined;
}

function invalid(message: string): never {
  throw new NormalizationError("invalid_input", message);
}
