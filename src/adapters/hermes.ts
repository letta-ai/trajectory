import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../internal.js";
import type { Diagnostic } from "../types.js";
import { NormalizationError } from "../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseTimestamp,
} from "./shared.js";

/**
 * Hermes persists multimodal message content as JSON behind this sentinel
 * prefix (`HermesState._CONTENT_JSON_PREFIX`); scalar content is stored as-is.
 */
const CONTENT_JSON_PREFIX = "\u0000json:";

interface HermesToolCall {
  id?: string;
  name?: string;
  args: string;
}

export const hermesAdapter: SourceAdapter = {
  source: "hermes",

  decode(transcript: string): DecodedSession {
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const parsed = parseTranscript(transcript);

    // Soft-deleted rows (`active: 0`) are rewound history that Hermes itself
    // excludes from replay; drop them before ordering and call/result linking.
    const rows = orderRows(
      parsed.messages.filter((row) => row.active !== 0 && row.active !== false),
    );
    const callsByRow = planToolCalls(rows, diagnostics);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      const timestamp = hermesTimestamp(row.timestamp);
      // Native identity: the messages-table AUTOINCREMENT id, which is also the
      // authoritative insertion order. Hand-assembled exports without ids fall
      // back to the whole-decode ordinal.
      const id = rowId(row);
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          ...(id !== undefined
            ? { sourceRecordId: String(id) }
            : { sourceOffset: index, sourceAnchorKind: "ordinal" }),
          ...(typeof id === "number" ? { sourceSequence: id } : {}),
          componentIndex: componentIndex++,
        });
      };

      if (row.role === "user") {
        const content = contentText(row.content);
        if (content) {
          emit({
            type: "message",
            role: "user",
            content,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (row.role === "assistant") {
        const reasoning = reasoningText(row);
        if (reasoning) {
          emit({
            type: "reasoning",
            content: reasoning,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        const content = contentText(row.content);
        if (content) {
          emit({
            type: "message",
            role: "assistant",
            content,
            ...(timestamp ? { timestamp } : {}),
          });
        }
        for (const call of callsByRow.get(index) ?? []) {
          emit({
            type: "tool_call",
            args: call.args,
            ...(call.id ? { id: call.id } : {}),
            ...(call.name ? { name: call.name } : {}),
            ...(timestamp ? { timestamp } : {}),
          });
        }
        continue;
      }

      if (row.role === "tool") {
        emit({
          type: "tool_result",
          content: contentText(row.content),
          ...(typeof row.tool_call_id === "string" && row.tool_call_id
            ? { callId: row.tool_call_id }
            : {}),
          ...(timestamp ? { timestamp } : {}),
        });
      }
      // Any other role (e.g. an injected system row) is harness transport noise;
      // the session-level system prompt lives on the sessions table, not here.
    }

    const session = parsed.session ?? {};
    const model =
      typeof session.model === "string" && session.model ? session.model : undefined;
    const cwd = typeof session.cwd === "string" && session.cwd ? session.cwd : undefined;
    const createdAt = hermesTimestamp(session.started_at);
    const sourceGroupId = resolveGroupId(session, parsed.messages);

    return {
      events,
      context: {
        source: "hermes",
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(sourceGroupId ? { sourceGroupId } : {}),
      },
      diagnostics,
    };
  },
};

type HermesRow = Record<string, unknown>;

interface ParsedHermesTranscript {
  session?: HermesRow;
  messages: HermesRow[];
}

function parseTranscript(transcript: string): ParsedHermesTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidHermesTranscript();
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isObject)) throw invalidHermesTranscript();
    return { messages: parsed };
  }
  if (isObject(parsed) && Array.isArray(parsed.messages)) {
    if (!parsed.messages.every(isObject)) throw invalidHermesTranscript();
    return {
      messages: parsed.messages,
      ...(isObject(parsed.session) ? { session: parsed.session } : {}),
    };
  }
  throw invalidHermesTranscript();
}

/**
 * Restore insertion order by the AUTOINCREMENT row id when every row has one.
 * Hermes orders replay by id rather than timestamp (clock regressions), so the
 * id is authoritative. Exports without ids keep their array order.
 */
function orderRows(rows: HermesRow[]): HermesRow[] {
  if (!rows.every((row) => typeof row.id === "number")) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        (left.row.id as number) - (right.row.id as number) ||
        left.index - right.index,
    )
    .map(({ row }) => row);
}

/**
 * Resolve tool-call identity per assistant row. Hermes stores two shapes:
 * OpenAI Chat Completions dicts (`{id, function: {name, arguments}}`, possibly
 * carrying Codex Responses extras) and a simplified `{name, arguments}` form
 * flushed from provider SDK objects, which has no call id. For the id-less
 * form, adopt the ids of the tool rows answering that turn (they are appended
 * in call order) — but only when the counts line up exactly, so a mismatch
 * degrades to synthesized ids instead of mislinked results.
 */
function planToolCalls(
  rows: HermesRow[],
  diagnostics: Diagnostic[],
): Map<number, HermesToolCall[]> {
  const plan = new Map<number, HermesToolCall[]>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined || row.role !== "assistant") continue;
    const calls = rowToolCalls(row, index, diagnostics);
    if (calls.length === 0) continue;

    const idless = calls.filter((call) => !call.id);
    if (idless.length > 0) {
      const claimed = new Set(
        calls.flatMap((call) => (call.id ? [call.id] : [])),
      );
      const available: string[] = [];
      for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
        const next = rows[cursor];
        if (next === undefined) continue;
        if (next.role !== "tool") break;
        if (
          typeof next.tool_call_id === "string" &&
          next.tool_call_id &&
          !claimed.has(next.tool_call_id)
        ) {
          available.push(next.tool_call_id);
        }
      }
      if (available.length === idless.length) {
        for (let position = 0; position < idless.length; position += 1) {
          const call = idless[position];
          const adopted = available[position];
          if (call && adopted !== undefined) call.id = adopted;
        }
      }
    }

    plan.set(index, calls);
  }
  return plan;
}

function rowToolCalls(
  row: HermesRow,
  index: number,
  diagnostics: Diagnostic[],
): HermesToolCall[] {
  let raw = row.tool_calls;
  // The SQLite column stores tool_calls as a JSON string; `get_messages()`
  // exports decode it. Accept both.
  if (typeof raw === "string" && raw) {
    try {
      raw = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "invalid_json_line",
        message: `Skipped undecodable tool_calls on message ${index + 1}.`,
        inputLine: index + 1,
      });
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const calls: HermesToolCall[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const fn = isObject(entry.function) ? entry.function : undefined;
    const name = firstString(fn?.name, entry.name);
    // Codex Responses providers persist `call_id` alongside or instead of `id`.
    const id = firstString(entry.id, entry.call_id);
    const args = fn !== undefined ? fn.arguments : entry.arguments;
    calls.push({
      args: typeof args === "string" && args ? args : jsonString(args),
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
    });
  }
  return calls;
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    if (content.startsWith(CONTENT_JSON_PREFIX)) {
      const encoded = content.slice(CONTENT_JSON_PREFIX.length);
      try {
        return contentText(JSON.parse(encoded));
      } catch {
        return encoded;
      }
    }
    return content;
  }
  if (Array.isArray(content)) return blocksText(content);
  if (content === null || content === undefined) return "";
  if (isObject(content)) return jsonString(content);
  return String(content);
}

/**
 * `reasoning` holds the streamed chain-of-thought; `reasoning_content` is the
 * provider SDK field, promoted from `reasoning` at write time when absent, but
 * sometimes only a single-space pad required by thinking-mode replay. Prefer
 * the provider field when it carries real text, otherwise fall back.
 */
function reasoningText(row: HermesRow): string {
  if (typeof row.reasoning_content === "string" && row.reasoning_content.trim()) {
    return row.reasoning_content;
  }
  if (typeof row.reasoning === "string" && row.reasoning.trim()) {
    return row.reasoning;
  }
  return "";
}

/** Hermes timestamps are Unix epoch seconds (`time.time()`), possibly fractional. */
function hermesTimestamp(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 1e11 ? value : value * 1_000;
    const date = new Date(Math.round(milliseconds));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return parseTimestamp(value);
}

function rowId(row: HermesRow): number | string | undefined {
  if (typeof row.id === "number" && Number.isFinite(row.id)) return row.id;
  if (typeof row.id === "string" && row.id) return row.id;
  return undefined;
}

function resolveGroupId(
  session: HermesRow,
  messages: HermesRow[],
): string | undefined {
  if (typeof session.id === "string" && session.id) return session.id;
  for (const row of messages) {
    if (typeof row.session_id === "string" && row.session_id) {
      return row.session_id;
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function invalidHermesTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "Hermes transcript must be a JSON array of session-store message rows or an object with a messages array.",
  );
}
