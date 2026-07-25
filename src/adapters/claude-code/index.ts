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
  jsonString,
  parseJsonLines,
  parseTimestamp,
} from "../shared.js";

const TRANSPORT_TYPES = new Set([
  "progress",
  "queue-operation",
  "file-history-snapshot",
  "summary",
  "system",
  "pr-link",
  "last-prompt",
  "custom-title",
  "ai-title",
  "agent-name",
  "permission-mode",
  "attachment",
  "mode",
]);

export const claudeCodeAdapter: SourceAdapter = {
  source: "claude-code",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const rows = [...parseJsonLines(transcript, diagnostics)];
    // Claude Code writes each subagent to its own JSONL with every conversational
    // row marked `isSidechain: true`. The same flag is also used for sidechain
    // rows embedded alongside a parent transcript. When ordinary conversational
    // rows exist, preserve the parent-level view by excluding sidechain rows;
    // when all conversational rows are sidechain rows, this is the standalone
    // subagent transcript and those rows are the primary conversation.
    const standaloneSidechain =
      rows.some(({ value }) => isConversationalRecord(value) && value.isSidechain === true) &&
      !rows.some(
        ({ value }) =>
          isConversationalRecord(value) && value.isSidechain !== true,
      );
    // Resolve session context from source chronology, not input order, so the
    // meta record and its hashes do not depend on transport-arrival order.
    let cwdCandidate: ContextCandidate | undefined;
    let branchCandidate: ContextCandidate | undefined;
    const sessionIds = new Set<string>();
    const agentIds = new Set<string>();

    for (const { value: record, line, byteOffset } of rows) {
      const recordType = record.type;
      if (record.isSidechain === true && !standaloneSidechain) {
        diagnostics.push({
          code: "sidechain_record_dropped",
          message: `Dropped a Claude Code sidechain record on line ${line}.`,
          inputLine: line,
        });
        continue;
      }
      if (typeof recordType === "string" && TRANSPORT_TYPES.has(recordType)) {
        continue;
      }
      const contextKey: ContextKey = {
        ts: parseTimestamp(record.timestamp)?.getTime() ?? Number.POSITIVE_INFINITY,
        tie:
          typeof record.uuid === "string" && record.uuid
            ? record.uuid
            : `@${byteOffset}`,
      };
      if (typeof record.cwd === "string" && record.cwd) {
        cwdCandidate = earlier(cwdCandidate, { ...contextKey, value: record.cwd });
      }
      if (typeof record.gitBranch === "string" && record.gitBranch) {
        branchCandidate = earlier(branchCandidate, {
          ...contextKey,
          value: record.gitBranch,
        });
      }
      if (typeof record.sessionId === "string" && record.sessionId) {
        sessionIds.add(record.sessionId);
      }
      if (
        standaloneSidechain &&
        typeof record.agentId === "string" &&
        record.agentId
      ) {
        agentIds.add(record.agentId);
      }

      if (recordType !== "user" && recordType !== "assistant") continue;
      if (!isObject(record.message)) continue;

      const message = record.message;
      const timestamp = parseTimestamp(record.timestamp);
      const model = typeof message.model === "string" ? message.model : undefined;
      const content = message.content;
      // Native per-record identity: the line `uuid` (falling back to the line
      // offset). `componentIndex` disambiguates multiple components decoded from
      // the same line, identically across duplicate occurrences.
      const uuid = typeof record.uuid === "string" && record.uuid ? record.uuid : undefined;
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          ...(uuid !== undefined ? { sourceRecordId: uuid } : {}),
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: componentIndex++,
        });
      };

      if (recordType === "user") {
        if (typeof content === "string") {
          emit(messageEvent("user", content, line, timestamp));
          continue;
        }

        const textParts: string[] = [];
        for (const block of Array.isArray(content) ? content : []) {
          if (!isObject(block)) continue;
          if (block.type === "tool_result") {
            emit(
              toolResultEvent(
                blocksText(block.content),
                typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
                line,
                timestamp,
              ),
            );
          } else if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "image") {
            textParts.push("[image]");
          }
        }
        if (textParts.length > 0) {
          emit(messageEvent("user", textParts.join("\n"), line, timestamp));
        }
        continue;
      }

      if (typeof content === "string") {
        if (content.trim()) {
          emit(messageEvent("assistant", content, line, timestamp, model));
        }
        continue;
      }

      for (const block of Array.isArray(content) ? content : []) {
        if (!isObject(block)) continue;
        if (block.type === "thinking") {
          emit(
            reasoningEvent(
              typeof block.thinking === "string" ? block.thinking : "",
              line,
              timestamp,
              model,
            ),
          );
        } else if (block.type === "text") {
          emit(
            messageEvent(
              "assistant",
              typeof block.text === "string" ? block.text : "",
              line,
              timestamp,
              model,
            ),
          );
        } else if (block.type === "tool_use") {
          emit(
            toolCallEvent(
              typeof block.id === "string" ? block.id : undefined,
              typeof block.name === "string" ? block.name : undefined,
              jsonString(block.input),
              line,
              timestamp,
              model,
            ),
          );
        }
      }
    }

    if (agentIds.size > 1) {
      throw new NormalizationError(
        "source_group_conflict",
        `Claude Code subagent transcript contains multiple agent ids: ${[...agentIds]
          .map((id) => JSON.stringify(id))
          .sort()
          .join(", ")}.`,
      );
    }
    // A standalone subagent is grouped by its own agent id, so parent session-id
    // drift does not make its identity ambiguous. Ordinary transcripts, and
    // older subagent transcripts without agentId, still require one session id.
    if (
      sessionIds.size > 1 &&
      (!standaloneSidechain || agentIds.size === 0)
    ) {
      throw new NormalizationError(
        "source_group_conflict",
        `Claude Code transcript contains multiple session ids: ${[...sessionIds]
          .map((id) => JSON.stringify(id))
          .sort()
          .join(", ")}.`,
      );
    }
    const [sessionId] = sessionIds;
    const [agentId] = agentIds;
    const cwd = cwdCandidate?.value;
    const gitBranch = branchCandidate?.value;

    return {
      events,
      context: {
        source: "claude-code",
        ...(cwd ? { cwd } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(agentId || sessionId
          ? { sourceGroupId: agentId || sessionId }
          : {}),
      },
      diagnostics,
    };
  },
};

function isConversationalRecord(record: Record<string, unknown>): boolean {
  return (
    (record.type === "user" || record.type === "assistant") &&
    isObject(record.message)
  );
}

interface ContextKey {
  ts: number;
  tie: string;
}

interface ContextCandidate extends ContextKey {
  value: string;
}

/** Pick the chronologically-earliest candidate, tie-broken by stable record id. */
function earlier(
  current: ContextCandidate | undefined,
  next: ContextCandidate,
): ContextCandidate {
  if (current === undefined) return next;
  if (next.ts < current.ts) return next;
  if (next.ts > current.ts) return current;
  return next.tie < current.tie ? next : current;
}

function messageEvent(
  role: "user" | "assistant",
  content: string,
  inputLine: number,
  timestamp?: Date,
  model?: string,
): DecodedEvent {
  return {
    type: "message",
    role,
    content,
    inputLine,
    ...(timestamp ? { timestamp } : {}),
    ...(model ? { model } : {}),
  };
}

function reasoningEvent(
  content: string,
  inputLine: number,
  timestamp?: Date,
  model?: string,
): DecodedEvent {
  return {
    type: "reasoning",
    content,
    inputLine,
    ...(timestamp ? { timestamp } : {}),
    ...(model ? { model } : {}),
  };
}

function toolCallEvent(
  id: string | undefined,
  name: string | undefined,
  args: string,
  inputLine: number,
  timestamp?: Date,
  model?: string,
): DecodedEvent {
  return {
    type: "tool_call",
    args,
    inputLine,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(model ? { model } : {}),
  };
}

function toolResultEvent(
  content: string,
  callId: string | undefined,
  inputLine: number,
  timestamp?: Date,
): DecodedEvent {
  return {
    type: "tool_result",
    content,
    inputLine,
    ...(callId ? { callId } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}
