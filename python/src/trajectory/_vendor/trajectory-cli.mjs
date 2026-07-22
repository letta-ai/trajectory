// src/python-cli.ts
import { readFileSync, writeFileSync } from "node:fs";

// src/types.ts
class NormalizationError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "NormalizationError";
    this.code = code;
  }
}

// src/adapters/shared.ts
function parseJsonLines(transcript, diagnostics) {
  const parsed = [];
  const lines = transcript.split(`
`);
  let byteOffset = 0;
  for (let index = 0;index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined)
      continue;
    const lineByteOffset = byteOffset;
    byteOffset += utf8ByteLength(raw) + 1;
    if (!raw.trim())
      continue;
    const line = index + 1;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "invalid_json_line",
        message: `Skipped invalid JSON on line ${line}.`,
        inputLine: line
      });
      continue;
    }
    if (!isObject(value)) {
      diagnostics.push({
        code: "non_object_json_line",
        message: `Skipped non-object JSON on line ${line}.`,
        inputLine: line
      });
      continue;
    }
    parsed.push({ value, line, byteOffset: lineByteOffset });
  }
  return parsed;
}
function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value;
  if (typeof value === "number" && value > 100000000000) {
    const date2 = new Date(value);
    return Number.isNaN(date2.getTime()) ? undefined : date2;
  }
  if (typeof value !== "string" || value.length === 0)
    return;
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
function blocksText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const item of content) {
    if (!isObject(item))
      continue;
    const type = item.type;
    if (type === "text" || type === "input_text" || type === "output_text" || type === undefined && "text" in item) {
      if (typeof item.text === "string" && item.text.length > 0) {
        parts.push(item.text);
      }
    } else if (type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join(`
`);
}
function jsonString(value) {
  const serialized = JSON.stringify(value ?? {});
  return serialized === undefined ? "{}" : serialized;
}

// src/adapters/claude-code.ts
var TRANSPORT_TYPES = new Set([
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
  "mode"
]);
var claudeCodeAdapter = {
  source: "claude-code",
  decode(transcript) {
    const diagnostics = [];
    const events = [];
    let cwdCandidate;
    let branchCandidate;
    const sessionIds = new Set;
    for (const { value: record, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
      const recordType = record.type;
      if (record.isSidechain === true) {
        diagnostics.push({
          code: "sidechain_record_dropped",
          message: `Dropped a Claude Code sidechain record on line ${line}.`,
          inputLine: line
        });
        continue;
      }
      if (typeof recordType === "string" && TRANSPORT_TYPES.has(recordType)) {
        continue;
      }
      const contextKey = {
        ts: parseTimestamp(record.timestamp)?.getTime() ?? Number.POSITIVE_INFINITY,
        tie: typeof record.uuid === "string" && record.uuid ? record.uuid : `@${byteOffset}`
      };
      if (typeof record.cwd === "string" && record.cwd) {
        cwdCandidate = earlier(cwdCandidate, { ...contextKey, value: record.cwd });
      }
      if (typeof record.gitBranch === "string" && record.gitBranch) {
        branchCandidate = earlier(branchCandidate, {
          ...contextKey,
          value: record.gitBranch
        });
      }
      if (typeof record.sessionId === "string" && record.sessionId) {
        sessionIds.add(record.sessionId);
      }
      if (recordType !== "user" && recordType !== "assistant")
        continue;
      if (!isObject(record.message))
        continue;
      const message = record.message;
      const timestamp = parseTimestamp(record.timestamp);
      const model = typeof message.model === "string" ? message.model : undefined;
      const content = message.content;
      const uuid = typeof record.uuid === "string" && record.uuid ? record.uuid : undefined;
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          ...uuid !== undefined ? { sourceRecordId: uuid } : {},
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: componentIndex++
        });
      };
      if (recordType === "user") {
        if (typeof content === "string") {
          emit(messageEvent("user", content, line, timestamp));
          continue;
        }
        const textParts = [];
        for (const block of Array.isArray(content) ? content : []) {
          if (!isObject(block))
            continue;
          if (block.type === "tool_result") {
            emit(toolResultEvent(blocksText(block.content), typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, line, timestamp));
          } else if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "image") {
            textParts.push("[image]");
          }
        }
        if (textParts.length > 0) {
          emit(messageEvent("user", textParts.join(`
`), line, timestamp));
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
        if (!isObject(block))
          continue;
        if (block.type === "thinking") {
          emit(reasoningEvent(typeof block.thinking === "string" ? block.thinking : "", line, timestamp, model));
        } else if (block.type === "text") {
          emit(messageEvent("assistant", typeof block.text === "string" ? block.text : "", line, timestamp, model));
        } else if (block.type === "tool_use") {
          emit(toolCallEvent(typeof block.id === "string" ? block.id : undefined, typeof block.name === "string" ? block.name : undefined, jsonString(block.input), line, timestamp, model));
        }
      }
    }
    if (sessionIds.size > 1) {
      throw new NormalizationError("source_group_conflict", `Claude Code transcript contains multiple session ids: ${[...sessionIds].map((id) => JSON.stringify(id)).sort().join(", ")}.`);
    }
    const [sessionId] = sessionIds;
    const cwd = cwdCandidate?.value;
    const gitBranch = branchCandidate?.value;
    return {
      events,
      context: {
        source: "claude-code",
        ...cwd ? { cwd } : {},
        ...gitBranch ? { gitBranch } : {},
        ...sessionId ? { sourceGroupId: sessionId } : {}
      },
      diagnostics
    };
  }
};
function earlier(current, next) {
  if (current === undefined)
    return next;
  if (next.ts < current.ts)
    return next;
  if (next.ts > current.ts)
    return current;
  return next.tie < current.tie ? next : current;
}
function messageEvent(role, content, inputLine, timestamp, model) {
  return {
    type: "message",
    role,
    content,
    inputLine,
    ...timestamp ? { timestamp } : {},
    ...model ? { model } : {}
  };
}
function reasoningEvent(content, inputLine, timestamp, model) {
  return {
    type: "reasoning",
    content,
    inputLine,
    ...timestamp ? { timestamp } : {},
    ...model ? { model } : {}
  };
}
function toolCallEvent(id, name, args, inputLine, timestamp, model) {
  return {
    type: "tool_call",
    args,
    inputLine,
    ...id ? { id } : {},
    ...name ? { name } : {},
    ...timestamp ? { timestamp } : {},
    ...model ? { model } : {}
  };
}
function toolResultEvent(content, callId, inputLine, timestamp) {
  return {
    type: "tool_result",
    content,
    inputLine,
    ...callId ? { callId } : {},
    ...timestamp ? { timestamp } : {}
  };
}

// src/adapters/codex.ts
var INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
  "<turn_context>"
];
var codexAdapter = {
  source: "codex",
  decode(transcript) {
    const diagnostics = [];
    const events = [];
    let cwd;
    let gitBranch;
    let model;
    let createdAt;
    let sessionId;
    for (const { value: record, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
      const recordType = record.type;
      const payload = isObject(record.payload) ? record.payload : {};
      const timestamp = parseTimestamp(record.timestamp);
      const payloadType = payload.type;
      const emit = (event) => {
        events.push({
          ...event,
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: 0
        });
      };
      if (recordType === "session_meta") {
        if (!cwd && typeof payload.cwd === "string" && payload.cwd)
          cwd = payload.cwd;
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
        if (!cwd && typeof payload.cwd === "string" && payload.cwd)
          cwd = payload.cwd;
        if (!model && typeof payload.model === "string" && payload.model) {
          model = payload.model;
        }
        continue;
      }
      if (recordType === "event_msg") {
        if (payloadType === "agent_reasoning" && typeof payload.text === "string" && payload.text.trim()) {
          emit({
            type: "reasoning",
            content: payload.text,
            inputLine: line,
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (recordType !== "response_item")
        continue;
      if (payloadType === "message") {
        const role = payload.role;
        const content = blocksText(payload.content);
        if (role === "user") {
          const head = content.trimStart();
          if (INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) {
            diagnostics.push({
              code: "injected_context_dropped",
              message: `Dropped Codex system-injected user content on line ${line}.`,
              inputLine: line
            });
          } else {
            emit({
              type: "message",
              role: "user",
              content,
              inputLine: line,
              ...timestamp ? { timestamp } : {}
            });
          }
        } else if (role === "assistant") {
          emit({
            type: "message",
            role: "assistant",
            content,
            inputLine: line,
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (payloadType === "function_call") {
        emit({
          type: "tool_call",
          args: typeof payload.arguments === "string" && payload.arguments ? payload.arguments : "{}",
          inputLine: line,
          ...typeof payload.call_id === "string" ? { id: payload.call_id } : {},
          ...typeof payload.name === "string" ? { name: payload.name } : {},
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      if (payloadType === "custom_tool_call") {
        emit({
          type: "tool_call",
          args: jsonString({ input: payload.input ?? "" }),
          inputLine: line,
          ...typeof payload.call_id === "string" ? { id: payload.call_id } : {},
          ...typeof payload.name === "string" ? { name: payload.name } : {},
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      if (payloadType === "web_search_call") {
        const args = {};
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
          ...typeof payload.call_id === "string" ? { id: payload.call_id } : {},
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      if (payloadType === "tool_search_call") {
        emit({
          type: "tool_call",
          name: "tool_search",
          args: typeof payload.arguments === "string" && payload.arguments ? payload.arguments : jsonString(payload.arguments),
          inputLine: line,
          ...typeof payload.call_id === "string" ? { id: payload.call_id } : {},
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output" || payloadType === "tool_search_output") {
        emit({
          type: "tool_result",
          content: payloadType === "tool_search_output" ? jsonString(payload.tools ?? []) : outputText(payload.output),
          inputLine: line,
          ...typeof payload.call_id === "string" ? { callId: payload.call_id } : {},
          ...timestamp ? { timestamp } : {}
        });
      }
    }
    return {
      events,
      context: {
        source: "codex",
        ...cwd ? { cwd } : {},
        ...gitBranch ? { gitBranch } : {},
        ...model ? { model } : {},
        ...createdAt ? { createdAt } : {},
        ...sessionId ? { sourceGroupId: sessionId } : {}
      },
      diagnostics
    };
  }
};
function outputText(output) {
  if (typeof output === "string")
    return output;
  if (Array.isArray(output))
    return blocksText(output) || jsonString(output);
  if (isObject(output)) {
    return typeof output.content === "string" && output.content ? output.content : jsonString(output);
  }
  return output == null ? "" : String(output);
}

// src/adapters/hermes.ts
var CONTENT_JSON_PREFIX = "\x00json:";
var hermesAdapter = {
  source: "hermes",
  decode(transcript) {
    const diagnostics = [];
    const events = [];
    const parsed = parseTranscript(transcript);
    const rows = orderRows(parsed.messages.filter((row) => row.active !== 0 && row.active !== false));
    const callsByRow = planToolCalls(rows, diagnostics);
    for (let index = 0;index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined)
        continue;
      const timestamp = hermesTimestamp(row.timestamp);
      const id = rowId(row);
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          ...id !== undefined ? { sourceRecordId: String(id) } : { sourceOffset: index, sourceAnchorKind: "ordinal" },
          ...typeof id === "number" ? { sourceSequence: id } : {},
          componentIndex: componentIndex++
        });
      };
      if (row.role === "user") {
        const content = contentText(row.content);
        if (content) {
          emit({
            type: "message",
            role: "user",
            content,
            ...timestamp ? { timestamp } : {}
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
            ...timestamp ? { timestamp } : {}
          });
        }
        const content = contentText(row.content);
        if (content) {
          emit({
            type: "message",
            role: "assistant",
            content,
            ...timestamp ? { timestamp } : {}
          });
        }
        for (const call of callsByRow.get(index) ?? []) {
          emit({
            type: "tool_call",
            args: call.args,
            ...call.id ? { id: call.id } : {},
            ...call.name ? { name: call.name } : {},
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (row.role === "tool") {
        emit({
          type: "tool_result",
          content: contentText(row.content),
          ...typeof row.tool_call_id === "string" && row.tool_call_id ? { callId: row.tool_call_id } : {},
          ...timestamp ? { timestamp } : {}
        });
      }
    }
    const session = parsed.session ?? {};
    const model = typeof session.model === "string" && session.model ? session.model : undefined;
    const cwd = typeof session.cwd === "string" && session.cwd ? session.cwd : undefined;
    const createdAt = hermesTimestamp(session.started_at);
    const sourceGroupId = resolveGroupId(session, parsed.messages);
    return {
      events,
      context: {
        source: "hermes",
        ...cwd ? { cwd } : {},
        ...model ? { model } : {},
        ...createdAt ? { createdAt } : {},
        ...sourceGroupId ? { sourceGroupId } : {}
      },
      diagnostics
    };
  }
};
function parseTranscript(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidHermesTranscript();
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isObject))
      throw invalidHermesTranscript();
    return { messages: parsed };
  }
  if (isObject(parsed) && Array.isArray(parsed.messages)) {
    if (!parsed.messages.every(isObject))
      throw invalidHermesTranscript();
    return {
      messages: parsed.messages,
      ...isObject(parsed.session) ? { session: parsed.session } : {}
    };
  }
  throw invalidHermesTranscript();
}
function orderRows(rows) {
  if (!rows.every((row) => typeof row.id === "number"))
    return rows;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => left.row.id - right.row.id || left.index - right.index).map(({ row }) => row);
}
function planToolCalls(rows, diagnostics) {
  const plan = new Map;
  for (let index = 0;index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined || row.role !== "assistant")
      continue;
    const calls = rowToolCalls(row, index, diagnostics);
    if (calls.length === 0)
      continue;
    const idless = calls.filter((call) => !call.id);
    if (idless.length > 0) {
      const claimed = new Set(calls.flatMap((call) => call.id ? [call.id] : []));
      const available = [];
      for (let cursor = index + 1;cursor < rows.length; cursor += 1) {
        const next = rows[cursor];
        if (next === undefined)
          continue;
        if (next.role !== "tool")
          break;
        if (typeof next.tool_call_id === "string" && next.tool_call_id && !claimed.has(next.tool_call_id)) {
          available.push(next.tool_call_id);
        }
      }
      if (available.length === idless.length) {
        for (let position = 0;position < idless.length; position += 1) {
          const call = idless[position];
          const adopted = available[position];
          if (call && adopted !== undefined)
            call.id = adopted;
        }
      }
    }
    plan.set(index, calls);
  }
  return plan;
}
function rowToolCalls(row, index, diagnostics) {
  let raw = row.tool_calls;
  if (typeof raw === "string" && raw) {
    try {
      raw = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "invalid_json_line",
        message: `Skipped undecodable tool_calls on message ${index + 1}.`,
        inputLine: index + 1
      });
      return [];
    }
  }
  if (!Array.isArray(raw))
    return [];
  const calls = [];
  for (const entry of raw) {
    if (!isObject(entry))
      continue;
    const fn = isObject(entry.function) ? entry.function : undefined;
    const name = firstString(fn?.name, entry.name);
    const id = firstString(entry.id, entry.call_id);
    const args = fn !== undefined ? fn.arguments : entry.arguments;
    calls.push({
      args: typeof args === "string" && args ? args : jsonString(args),
      ...id ? { id } : {},
      ...name ? { name } : {}
    });
  }
  return calls;
}
function contentText(content) {
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
  if (Array.isArray(content))
    return blocksText(content);
  if (content === null || content === undefined)
    return "";
  if (isObject(content))
    return jsonString(content);
  return String(content);
}
function reasoningText(row) {
  if (typeof row.reasoning_content === "string" && row.reasoning_content.trim()) {
    return row.reasoning_content;
  }
  if (typeof row.reasoning === "string" && row.reasoning.trim()) {
    return row.reasoning;
  }
  return "";
}
function hermesTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 100000000000 ? value : value * 1000;
    const date = new Date(Math.round(milliseconds));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return parseTimestamp(value);
}
function rowId(row) {
  if (typeof row.id === "number" && Number.isFinite(row.id))
    return row.id;
  if (typeof row.id === "string" && row.id)
    return row.id;
  return;
}
function resolveGroupId(session, messages) {
  if (typeof session.id === "string" && session.id)
    return session.id;
  for (const row of messages) {
    if (typeof row.session_id === "string" && row.session_id) {
      return row.session_id;
    }
  }
  return;
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value)
      return value;
  }
  return;
}
function invalidHermesTranscript() {
  return new NormalizationError("invalid_input", "Hermes transcript must be a JSON array of session-store message rows or an object with a messages array.");
}

// src/adapters/letta.ts
var lettaAdapter = {
  source: "letta",
  decode(transcript) {
    const events = [];
    const parsed = parseTranscript2(transcript);
    if (parsed.format === "local") {
      for (const entry of parsed.messages) {
        decodeLocalMessage(entry.message, entry.timestamp, entry.byteOffset, events);
      }
      return {
        events,
        context: {
          source: "letta",
          ...parsed.createdAt ? { createdAt: parsed.createdAt } : {}
        },
        diagnostics: []
      };
    }
    for (const message of parsed.messages) {
      const timestamp = parseTimestamp(message.date);
      const id = typeof message.id === "string" && message.id ? message.id : undefined;
      const seq = typeof message.seq_id === "number" ? message.seq_id : undefined;
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          ...id !== undefined ? { sourceRecordId: id } : {},
          ...seq !== undefined ? { sourceSequence: seq } : {},
          componentIndex: componentIndex++
        });
      };
      if (message.message_type === "user_message" || message.message_type === "assistant_message") {
        const content = blocksText(message.content);
        if (content) {
          emit({
            type: "message",
            role: message.message_type === "user_message" ? "user" : "assistant",
            content,
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (message.message_type === "reasoning_message") {
        if (typeof message.reasoning === "string" && message.reasoning) {
          emit({
            type: "reasoning",
            content: message.reasoning,
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (message.message_type === "tool_call_message" || message.message_type === "approval_request_message") {
        for (const call of messageToolCalls(message)) {
          emit({
            type: "tool_call",
            args: toolArguments(call.arguments),
            ...typeof call.tool_call_id === "string" && call.tool_call_id ? { id: call.tool_call_id } : {},
            ...typeof call.name === "string" && call.name ? { name: call.name } : {},
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (message.message_type === "tool_return_message") {
        for (const result of messageToolReturns(message)) {
          let content = toolReturnText(result.tool_return);
          if ((result.is_err === true || typeof result.status === "string" && result.status !== "success") && !/^error/i.test(content)) {
            content = `Error: ${content}`;
          }
          emit({
            type: "tool_result",
            content,
            ...typeof result.tool_call_id === "string" && result.tool_call_id ? { callId: result.tool_call_id } : {},
            ...timestamp ? { timestamp } : {}
          });
        }
      }
    }
    return {
      events,
      context: { source: "letta" },
      diagnostics: []
    };
  }
};
function parseTranscript2(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    return parseLocalJsonLines(transcript);
  }
  if (isObject(parsed)) {
    if (parsed.type === "session" || parsed.type === "message") {
      return parseLocalJsonLines(transcript);
    }
    if (typeof parsed.role === "string") {
      const timestamp = messageTimestamp(parsed);
      return {
        format: "local",
        messages: [
          {
            message: parsed,
            byteOffset: 0,
            ...timestamp ? { timestamp } : {}
          }
        ]
      };
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(isObject)) {
    throw invalidLettaTranscript();
  }
  const messages = parsed;
  if (!messages.every((message) => typeof message.seq_id === "number")) {
    return { format: "api", messages };
  }
  return {
    format: "api",
    messages: messages.map((message, index) => ({ message, index })).sort((left, right) => left.message.seq_id - right.message.seq_id || left.index - right.index).map(({ message }) => message)
  };
}
function parseLocalJsonLines(transcript) {
  const rows = [];
  let byteOffset = 0;
  for (const raw of transcript.split(`
`)) {
    const rowByteOffset = byteOffset;
    byteOffset += utf8ByteLength2(raw) + 1;
    if (!raw.trim())
      continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      throw invalidLettaTranscript();
    }
    if (!isObject(row))
      throw invalidLettaTranscript();
    rows.push({ row, byteOffset: rowByteOffset });
  }
  if (rows.length === 0)
    throw invalidLettaTranscript();
  const session = rows.find((entry) => entry.row.type === "session");
  if (session && session.row.version !== 3) {
    throw new NormalizationError("invalid_input", `Unsupported Letta local transcript version ${JSON.stringify(session.row.version)}; supported version: 3.`);
  }
  const hasMessageWrappers = rows.some((entry) => entry.row.type === "message");
  if (session || hasMessageWrappers) {
    const createdAt = session ? parseTimestamp(session.row.timestamp) : undefined;
    return {
      format: "local",
      messages: rows.flatMap((entry) => {
        if (entry.row.type !== "message" || !isObject(entry.row.message))
          return [];
        const timestamp = parseTimestamp(entry.row.timestamp);
        return [
          {
            message: entry.row.message,
            byteOffset: entry.byteOffset,
            ...timestamp ? { timestamp } : {}
          }
        ];
      }),
      ...createdAt ? { createdAt } : {}
    };
  }
  if (!rows.every((entry) => typeof entry.row.role === "string")) {
    throw invalidLettaTranscript();
  }
  return {
    format: "local",
    messages: rows.map((entry) => {
      const timestamp = messageTimestamp(entry.row);
      return {
        message: entry.row,
        byteOffset: entry.byteOffset,
        ...timestamp ? { timestamp } : {}
      };
    })
  };
}
function decodeLocalMessage(message, entryTimestamp, byteOffset, events) {
  const timestamp = entryTimestamp ?? messageTimestamp(message);
  const model = typeof message.model === "string" ? message.model : undefined;
  const id = typeof message.id === "string" && message.id ? message.id : undefined;
  let componentIndex = 0;
  const emit = (event) => {
    events.push({
      ...event,
      ...id !== undefined ? { sourceRecordId: id } : { sourceOffset: byteOffset, sourceAnchorKind: "byte" },
      componentIndex: componentIndex++
    });
  };
  if (message.role === "user") {
    const content = blocksText(message.content);
    if (content) {
      emit({
        type: "message",
        role: "user",
        content,
        ...timestamp ? { timestamp } : {}
      });
    }
    return;
  }
  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      if (message.content) {
        emit({
          type: "message",
          role: "assistant",
          content: message.content,
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      }
      return;
    }
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!isObject(part))
        continue;
      if (part.type === "thinking" && typeof part.thinking === "string") {
        emit({
          type: "reasoning",
          content: part.thinking,
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      } else if (part.type === "text" && typeof part.text === "string") {
        emit({
          type: "message",
          role: "assistant",
          content: part.text,
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      } else if (part.type === "toolCall") {
        emit({
          type: "tool_call",
          args: toolArguments(part.arguments),
          ...typeof part.id === "string" && part.id ? { id: part.id } : {},
          ...typeof part.name === "string" && part.name ? { name: part.name } : {},
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      }
    }
    return;
  }
  if (message.role === "toolResult" || message.role === "tool") {
    let content = blocksText(message.content);
    if (message.isError === true && !/^error/i.test(content)) {
      content = `Error: ${content}`;
    }
    const callId = typeof message.toolCallId === "string" ? message.toolCallId : typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
    emit({
      type: "tool_result",
      content,
      ...callId ? { callId } : {},
      ...timestamp ? { timestamp } : {}
    });
  }
}
function messageTimestamp(message) {
  const metadata = isObject(message.metadata) ? message.metadata : {};
  return parseTimestamp(metadata.created_at) ?? parseTimestamp(message.date) ?? parseTimestamp(message.timestamp);
}
function utf8ByteLength2(text) {
  return new TextEncoder().encode(text).length;
}
function toolArguments(value) {
  if (typeof value === "string" && value)
    return value;
  return jsonString(value);
}
function toolReturnText(value) {
  if (typeof value === "string")
    return value;
  if (value === undefined || value === null)
    return "";
  return jsonString(value);
}
function messageToolCalls(message) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
  if (calls.length > 0)
    return uniqueByCallId(calls);
  return isObject(message.tool_call) ? [message.tool_call] : [];
}
function messageToolReturns(message) {
  const results = Array.isArray(message.tool_returns) ? message.tool_returns.filter(isObject) : [];
  if (results.length > 0)
    return uniqueByCallId(results);
  return [message];
}
function uniqueByCallId(values) {
  const seen = new Set;
  return values.filter((value) => {
    if (typeof value.tool_call_id !== "string" || !value.tool_call_id) {
      return true;
    }
    if (seen.has(value.tool_call_id))
      return false;
    seen.add(value.tool_call_id);
    return true;
  });
}
function invalidLettaTranscript() {
  return new NormalizationError("invalid_input", "Letta transcript must be a native message array or local conversation JSONL.");
}

// src/adapters/openhands.ts
var openHandsAdapter = {
  source: "openhands",
  decode(transcript) {
    const diagnostics = [];
    const events = [];
    const rawEvents = parseEvents(transcript);
    const callIdByActionId = new Map;
    for (const event of rawEvents) {
      if (isObject(event) && event.kind === "ActionEvent" && typeof event.id === "string" && event.id) {
        callIdByActionId.set(event.id, actionCallId(event));
      }
    }
    for (const event of rawEvents) {
      if (!isObject(event) || typeof event.id !== "string" || !event.id) {
        continue;
      }
      const timestamp = parseTimestamp(event.timestamp);
      const sourceRecordId = event.id;
      let componentIndex = 0;
      const emit = (decoded) => {
        events.push({ ...decoded, sourceRecordId, componentIndex: componentIndex++ });
      };
      if (event.kind === "MessageEvent") {
        if (event.source !== "user" && event.source !== "agent")
          continue;
        const message = isObject(event.llm_message) ? event.llm_message : {};
        const content = joinTextContent(message.content);
        if (!content)
          continue;
        emit({
          type: "message",
          role: event.source === "user" ? "user" : "assistant",
          content,
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      if (event.kind === "ActionEvent") {
        const thought = joinTextContent(event.thought);
        if (thought) {
          emit({
            type: "reasoning",
            content: thought,
            ...timestamp ? { timestamp } : {}
          });
        }
        const callId2 = callIdByActionId.get(event.id) ?? actionCallId(event);
        emit({
          type: "tool_call",
          id: callId2,
          args: actionArgsText(event),
          ...typeof event.tool_name === "string" && event.tool_name ? { name: event.tool_name } : {},
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      const result = extractToolResultText(event);
      if (result === undefined)
        continue;
      const callId = typeof event.tool_call_id === "string" && event.tool_call_id ? event.tool_call_id : typeof event.action_id === "string" ? callIdByActionId.get(event.action_id) : undefined;
      emit({
        type: "tool_result",
        content: result,
        ...callId ? { callId } : {},
        ...timestamp ? { timestamp } : {}
      });
    }
    return {
      events,
      context: { source: "openhands" },
      diagnostics
    };
  }
};
function actionCallId(event) {
  return typeof event.tool_call_id === "string" && event.tool_call_id ? event.tool_call_id : `oh_${String(event.id)}`;
}
function parseEvents(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw new NormalizationError("invalid_input", "OpenHands transcript must be a JSON event array or an object with an items array.");
  }
  if (Array.isArray(parsed))
    return parsed;
  if (isObject(parsed) && Array.isArray(parsed.items))
    return parsed.items;
  throw new NormalizationError("invalid_input", "OpenHands transcript must be a JSON event array or an object with an items array.");
}
function joinTextContent(content) {
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const item of content) {
    if (isObject(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}
function actionArgsText(event) {
  if (isObject(event.tool_call)) {
    const raw = event.tool_call.arguments;
    if (typeof raw === "string" && raw)
      return raw;
  }
  if (isObject(event.action)) {
    const args = { ...event.action };
    delete args.kind;
    return jsonString(args);
  }
  return "{}";
}
function extractToolResultText(event) {
  if (event.kind === "ObservationEvent") {
    const observation = isObject(event.observation) ? event.observation : {};
    return joinTextContent(observation.content);
  }
  if (event.kind === "AgentErrorEvent") {
    return typeof event.error === "string" ? event.error : "";
  }
  if (event.kind === "UserRejectObservation") {
    return typeof event.rejection_reason === "string" ? event.rejection_reason : "";
  }
  return;
}

// src/adapters/deepagents.ts
function decodeDeepAgentsCheckpoint(checkpoint) {
  const events = [];
  const checkpointTimestamp = parseTimestamp(checkpoint.checkpointTimestamp);
  checkpoint.messages.forEach((message, offset) => {
    const timestamp = parseTimestamp(message.timestamp) ?? checkpointTimestamp;
    let componentIndex = 0;
    const emit = (event) => {
      events.push({
        ...event,
        sourceOffset: offset,
        sourceAnchorKind: "ordinal",
        componentIndex: componentIndex++
      });
    };
    if (message.role === "human") {
      if (message.content) {
        emit({
          type: "message",
          role: "user",
          content: message.content,
          ...timestamp ? { timestamp } : {}
        });
      }
      return;
    }
    if (message.role === "ai") {
      for (const reasoning of message.reasoning) {
        if (!reasoning)
          continue;
        emit({
          type: "reasoning",
          content: reasoning,
          ...timestamp ? { timestamp } : {},
          ...message.model ? { model: message.model } : {}
        });
      }
      if (message.content) {
        emit({
          type: "message",
          role: "assistant",
          content: message.content,
          ...timestamp ? { timestamp } : {},
          ...message.model ? { model: message.model } : {}
        });
      }
      for (const call of message.toolCalls) {
        emit({
          type: "tool_call",
          args: jsonString(call.args),
          ...call.id ? { id: call.id } : {},
          ...call.name ? { name: call.name } : {},
          ...timestamp ? { timestamp } : {},
          ...message.model ? { model: message.model } : {}
        });
      }
      return;
    }
    emit({
      type: "tool_result",
      callId: message.toolCallId,
      content: message.content,
      ...timestamp ? { timestamp } : {}
    });
  });
  return {
    events,
    context: {
      source: "deepagents",
      ...checkpoint.cwd ? { cwd: checkpoint.cwd } : {},
      ...checkpoint.model ? { model: checkpoint.model } : {},
      ...checkpointTimestamp ? { createdAt: checkpointTimestamp } : {},
      sourceGroupId: deepAgentsGroupId(checkpoint.threadId, checkpoint.checkpointNamespace)
    },
    diagnostics: []
  };
}
function deepAgentsGroupId(threadId, checkpointNamespace) {
  return JSON.stringify([threadId, checkpointNamespace]);
}

// src/bounds.ts
var DEFAULT_NORMALIZATION_BOUNDS = Object.freeze({
  toolArguments: Object.freeze({ maxCharacters: 20000 }),
  toolResults: Object.freeze({
    maxCharacters: 2500,
    strategy: "head-tail"
  })
});
function resolveBounds(bounds) {
  if (bounds === undefined)
    return copyDefaults();
  assertObject(bounds, "bounds");
  assertKnownKeys(bounds, ["toolArguments", "toolResults"], "bounds");
  const toolArguments2 = bounds.toolArguments;
  if (toolArguments2 !== undefined) {
    assertObject(toolArguments2, "bounds.toolArguments");
    assertKnownKeys(toolArguments2, ["maxCharacters"], "bounds.toolArguments");
  }
  const toolResults = bounds.toolResults;
  if (toolResults !== undefined) {
    assertObject(toolResults, "bounds.toolResults");
    assertKnownKeys(toolResults, ["maxCharacters", "strategy"], "bounds.toolResults");
  }
  const argumentLimit = resolveLimit(toolArguments2?.maxCharacters, DEFAULT_NORMALIZATION_BOUNDS.toolArguments.maxCharacters, "bounds.toolArguments.maxCharacters");
  if (argumentLimit !== null && argumentLimit < 2) {
    throw invalidBounds("bounds.toolArguments.maxCharacters must be at least 2 so arguments can remain a JSON object.");
  }
  const resultLimit = resolveLimit(toolResults?.maxCharacters, DEFAULT_NORMALIZATION_BOUNDS.toolResults.maxCharacters, "bounds.toolResults.maxCharacters");
  const strategy = toolResults?.strategy ?? DEFAULT_NORMALIZATION_BOUNDS.toolResults.strategy;
  if (strategy !== "head" && strategy !== "head-tail") {
    throw invalidBounds('bounds.toolResults.strategy must be either "head" or "head-tail".');
  }
  return {
    toolArguments: { maxCharacters: argumentLimit },
    toolResults: { maxCharacters: resultLimit, strategy }
  };
}
function copyDefaults() {
  return {
    toolArguments: {
      maxCharacters: DEFAULT_NORMALIZATION_BOUNDS.toolArguments.maxCharacters
    },
    toolResults: {
      maxCharacters: DEFAULT_NORMALIZATION_BOUNDS.toolResults.maxCharacters,
      strategy: DEFAULT_NORMALIZATION_BOUNDS.toolResults.strategy
    }
  };
}
function resolveLimit(value, fallback, path) {
  if (value === undefined)
    return fallback;
  if (value === null)
    return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidBounds(`${path} must be a positive safe integer or null.`);
  }
  return value;
}
function assertObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBounds(`${path} must be an object.`);
  }
}
function assertKnownKeys(value, knownKeys, path) {
  const unknown = Object.keys(value).find((key) => !knownKeys.includes(key));
  if (unknown !== undefined) {
    throw invalidBounds(`${path} contains unknown option ${JSON.stringify(unknown)}.`);
  }
}
function invalidBounds(message) {
  return new NormalizationError("invalid_input", message);
}

// src/validate.ts
var TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
var META_KEYS = new Set(["role", "source", "cwd", "git_branch", "model"]);
var CONTENT_KEYS = new Set(["role", "content", "timestamp"]);
var ASSISTANT_TOOL_KEYS = new Set(["role", "content", "timestamp", "tool_calls"]);
var TOOL_RESULT_KEYS = new Set(["role", "tool_call_id", "content", "timestamp"]);
var TOOL_CALL_KEYS = new Set(["id", "name", "args"]);
function validateTranscript(value, options) {
  const partial = options?.partial ?? false;
  if (!Array.isArray(value) || value.length === 0)
    fail("Transcript must be a non-empty array.");
  const allCallIds = collectCallIds(value);
  const callIds = new Set;
  const roles = new Set;
  let metaSeen = false;
  for (let index = 0;index < value.length; index += 1) {
    const record = value[index];
    if (!isObject2(record) || typeof record.role !== "string") {
      fail(`Record ${index} must be an object with a role.`);
    }
    roles.add(record.role);
    if (record.role === "meta") {
      if (index !== 0 || metaSeen)
        fail(`Record ${index}: meta must appear once at index 0.`);
      metaSeen = true;
      exactKeys(record, META_KEYS, index);
      if (typeof record.source !== "string" || !record.source) {
        fail(`Record ${index}: meta.source must be a non-empty string.`);
      }
      optionalString(record, "cwd", index);
      optionalString(record, "git_branch", index);
      optionalString(record, "model", index);
      continue;
    }
    validateTimestamp(record.timestamp, index);
    if (record.role === "user" || record.role === "reasoning") {
      exactKeys(record, CONTENT_KEYS, index);
      if (typeof record.content !== "string") {
        fail(`Record ${index}: ${record.role} content must be a string.`);
      }
      continue;
    }
    if (record.role === "assistant") {
      if ("tool_calls" in record) {
        exactKeys(record, ASSISTANT_TOOL_KEYS, index);
        if (record.content !== null) {
          fail(`Record ${index}: assistant tool-call content must be null.`);
        }
        if (!Array.isArray(record.tool_calls) || record.tool_calls.length === 0) {
          fail(`Record ${index}: assistant tool_calls must be a non-empty array.`);
        }
        for (const call of record.tool_calls)
          validateToolCall(call, index, callIds);
      } else {
        exactKeys(record, CONTENT_KEYS, index);
        if (typeof record.content !== "string" || !record.content) {
          fail(`Record ${index}: assistant content must be a non-empty string.`);
        }
      }
      continue;
    }
    if (record.role === "tool") {
      exactKeys(record, TOOL_RESULT_KEYS, index);
      if (typeof record.tool_call_id !== "string" || !record.tool_call_id || !partial && !allCallIds.has(record.tool_call_id)) {
        fail(`Record ${index}: tool result must reference a tool call.`);
      }
      if (typeof record.content !== "string") {
        fail(`Record ${index}: tool content must be a string.`);
      }
      continue;
    }
    fail(`Record ${index}: unknown role ${JSON.stringify(record.role)}.`);
  }
  if (!partial) {
    if (!roles.has("user"))
      fail("Transcript must contain at least one user record.");
    if (!roles.has("assistant")) {
      fail("Transcript must contain at least one assistant record.");
    }
  }
}
function collectCallIds(records) {
  const ids = new Set;
  for (const record of records) {
    if (!isObject2(record) || record.role !== "assistant")
      continue;
    if (!Array.isArray(record.tool_calls))
      continue;
    for (const call of record.tool_calls) {
      if (isObject2(call) && typeof call.id === "string" && call.id) {
        ids.add(call.id);
      }
    }
  }
  return ids;
}
function validateToolCall(call, recordIndex, callIds) {
  if (!isObject2(call))
    fail(`Record ${recordIndex}: tool call must be an object.`);
  exactKeys(call, TOOL_CALL_KEYS, recordIndex, "tool call");
  if (typeof call.id !== "string" || !call.id) {
    fail(`Record ${recordIndex}: tool-call ID must be a non-empty string.`);
  }
  if (callIds.has(call.id))
    fail(`Record ${recordIndex}: duplicate tool-call ID ${call.id}.`);
  if (typeof call.name !== "string" || !call.name) {
    fail(`Record ${recordIndex}: tool-call name must be a non-empty string.`);
  }
  if (typeof call.args !== "string") {
    fail(`Record ${recordIndex}: tool-call args must be a string.`);
  }
  let args;
  try {
    args = JSON.parse(call.args);
  } catch {
    fail(`Record ${recordIndex}: tool-call args must contain valid JSON.`);
  }
  if (!isObject2(args)) {
    fail(`Record ${recordIndex}: tool-call args must encode a JSON object.`);
  }
  callIds.add(call.id);
}
function validateTimestamp(value, recordIndex) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    fail(`Record ${recordIndex}: timestamp must be an ISO-8601 instant.`);
  }
}
function exactKeys(value, allowed, recordIndex, label = "record") {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra)
    fail(`Record ${recordIndex}: unexpected ${label} field ${JSON.stringify(extra)}.`);
}
function optionalString(value, key, recordIndex) {
  if (key in value && typeof value[key] !== "string") {
    fail(`Record ${recordIndex}: ${key} must be a string when present.`);
  }
}
function isObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message) {
  throw new NormalizationError("invalid_normalized_transcript", message);
}

// src/core.ts
var ARGS_LEAF_FLOOR = 2000;
var SYNTH_BASE_MS = Date.UTC(2026, 0, 1);
var SYNTH_STEP_SECONDS = 15;
var NOISE_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification"
];
function semanticBucket(event) {
  switch (event.type) {
    case "message":
      return "message";
    case "reasoning":
      return "reasoning";
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "tool_result";
  }
}
function planEvents(events) {
  const calls = new Map;
  const openCalls = new Map;
  const usedIds = new Set;
  const occOf = [];
  const bucketOf = [];
  let occurrence = -1;
  for (let index = 0;index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      occOf.push(occurrence);
      bucketOf.push("");
      continue;
    }
    if ((event.componentIndex ?? 0) === 0)
      occurrence += 1;
    const bucket = semanticBucket(event);
    occOf.push(occurrence);
    bucketOf.push(bucket);
    if (event.type === "tool_call") {
      const sourceId = event.id || `call_${index + 1}`;
      const synthesized = !event.id;
      let finalId = sourceId;
      let renamed = false;
      if (usedIds.has(finalId)) {
        let suffix = 2;
        while (usedIds.has(`${sourceId}__${suffix}`))
          suffix += 1;
        finalId = `${sourceId}__${suffix}`;
        renamed = true;
      }
      usedIds.add(finalId);
      const entries = openCalls.get(sourceId) ?? [];
      entries.push({ finalId, consumed: false });
      openCalls.set(sourceId, entries);
      calls.set(index, { finalId, renamed, synthesized, sourceId });
    }
  }
  const seen = new Map;
  const components = [];
  for (let index = 0;index < events.length; index += 1) {
    if (events[index] === undefined) {
      components.push(undefined);
      continue;
    }
    const key = `${occOf[index]}:${bucketOf[index]}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    components.push({ typeOrdinal: ordinal });
  }
  return { calls, openCalls, components };
}
function normalizeDecodedSession(decoded, bounds) {
  const internal = normalizeDecodedSessionInternal(decoded, bounds);
  return { records: internal.records, diagnostics: internal.diagnostics };
}
function normalizeDecodedSessionInternal(decoded, bounds, options) {
  const partial = options?.partial ?? false;
  const diagnostics = [...decoded.diagnostics];
  const body = [];
  const bodyBases = [];
  const anchors = new Map;
  const modelCounts = new Map;
  const plan = planEvents(decoded.events);
  for (let eventIndex = 0;eventIndex < decoded.events.length; eventIndex += 1) {
    const event = decoded.events[eventIndex];
    if (event === undefined)
      continue;
    if (event.model) {
      modelCounts.set(event.model, (modelCounts.get(event.model) ?? 0) + 1);
    }
    const record = normalizeEvent(event, eventIndex, body.length + 1, plan, diagnostics, bounds, partial);
    if (!record)
      continue;
    const hasTimestamp = event.timestamp !== undefined && !Number.isNaN(event.timestamp.getTime());
    if (hasTimestamp && event.timestamp) {
      anchors.set(body.length, event.timestamp);
    }
    const component = plan.components[eventIndex] ?? { typeOrdinal: 0 };
    body.push(record);
    bodyBases.push({
      componentIndex: event.componentIndex ?? 0,
      componentTypeOrdinal: component.typeOrdinal,
      ...event.sourceRecordId !== undefined ? { sourceRecordId: event.sourceRecordId } : {},
      ...event.sourceSequence !== undefined ? { sourceSequence: event.sourceSequence } : {},
      ...event.sourceOffset !== undefined ? { sourceOffset: event.sourceOffset } : {},
      ...event.sourceAnchorKind !== undefined ? { sourceAnchorKind: event.sourceAnchorKind } : {},
      ...hasTimestamp && event.timestamp ? { sourceTimestamp: event.timestamp.toISOString() } : {}
    });
  }
  const roles = new Set(body.map((record) => record.role));
  if (!partial) {
    if (!roles.has("user")) {
      throw new NormalizationError("missing_user_records", "Transcript did not contain any normalizable user records.");
    }
    if (!roles.has("assistant")) {
      throw new NormalizationError("missing_assistant_records", "Transcript did not contain any normalizable assistant records.");
    }
  }
  const timestamps = fillTimestamps(body.length, anchors, decoded.context, diagnostics);
  const stampedBody = body.map((record, index) => {
    const timestamp = timestamps[index];
    if (timestamp === undefined) {
      throw new NormalizationError("invalid_normalized_transcript", `Could not assign a timestamp to normalized record ${index}.`);
    }
    return { ...record, timestamp };
  });
  const meta = buildMeta(decoded.context, modelCounts);
  const records = [meta, ...stampedBody];
  validateTranscript(records, { partial });
  const recordTimestamps = [
    null,
    ...stampedBody.map((record) => record.timestamp)
  ];
  const bases = [null, ...bodyBases];
  return {
    records,
    bases,
    recordTimestamps,
    context: decoded.context,
    diagnostics,
    bounds
  };
}
function normalizeEvent(event, eventIndex, recordIndex, plan, diagnostics, bounds, partial) {
  if (event.type === "message") {
    if (!event.content.trim()) {
      return;
    }
    if (event.role === "user" && NOISE_PREFIXES.some((prefix) => event.content.trimStart().startsWith(prefix))) {
      diagnostics.push({
        code: "noise_record_dropped",
        message: "Dropped a harness-noise user record.",
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
      return;
    }
    if (event.role === "user") {
      const record3 = {
        role: "user",
        content: event.content
      };
      return record3;
    }
    const record2 = {
      role: "assistant",
      content: event.content
    };
    return record2;
  }
  if (event.type === "reasoning") {
    if (!event.content.trim()) {
      return;
    }
    const record2 = {
      role: "reasoning",
      content: event.content
    };
    return record2;
  }
  if (event.type === "tool_call") {
    const entry = plan.calls.get(eventIndex);
    const sourceId2 = entry?.sourceId ?? (event.id || `call_${eventIndex + 1}`);
    const finalId2 = entry?.finalId ?? sourceId2;
    if (entry?.synthesized ?? !event.id) {
      diagnostics.push({
        code: "tool_call_id_synthesized",
        message: `Synthesized tool-call ID ${JSON.stringify(sourceId2)}.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    if (entry?.renamed) {
      diagnostics.push({
        code: "duplicate_tool_call_id",
        message: `Renamed duplicate tool-call ID ${JSON.stringify(sourceId2)} to ${JSON.stringify(finalId2)}.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    const name = event.name || "unknown_tool";
    if (!event.name) {
      diagnostics.push({
        code: "unknown_tool_name",
        message: `Substituted ${JSON.stringify(name)} for a missing tool name.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    const args = shrinkArgs(event.args, bounds.toolArguments.maxCharacters);
    if (args.reshaped) {
      diagnostics.push({
        code: "tool_arguments_reshaped",
        message: `Reshaped arguments for tool call ${JSON.stringify(finalId2)} into a JSON object.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    if (args.truncated) {
      diagnostics.push({
        code: "tool_arguments_truncated",
        message: `Truncated arguments for tool call ${JSON.stringify(finalId2)} to at most ${bounds.toolArguments.maxCharacters} Unicode code points.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    const record2 = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: finalId2, name, args: args.args }]
    };
    return record2;
  }
  const sourceId = event.callId || "";
  const entries = plan.openCalls.get(sourceId);
  const openEntry = entries?.find((entry) => !entry.consumed);
  const crossChunk = !openEntry && partial && sourceId !== "" && !(entries && entries.length > 0);
  if (!openEntry && !crossChunk) {
    const duplicate = Boolean(entries && entries.length > 0);
    diagnostics.push({
      code: duplicate ? "duplicate_tool_result" : "orphan_tool_result",
      message: duplicate ? `Dropped a duplicate result for tool call ${JSON.stringify(sourceId)}.` : `Dropped a tool result without a preceding call for ${JSON.stringify(sourceId)}.`,
      recordIndex,
      ...event.inputLine ? { inputLine: event.inputLine } : {}
    });
    return;
  }
  if (openEntry)
    openEntry.consumed = true;
  const finalId = openEntry ? openEntry.finalId : sourceId;
  const resultLimit = bounds.toolResults.maxCharacters;
  const content = resultLimit === null ? event.content : truncateText(event.content, resultLimit, bounds.toolResults.strategy);
  if (content !== event.content) {
    diagnostics.push({
      code: "tool_result_truncated",
      message: `Truncated the result for tool call ${JSON.stringify(finalId)} to at most ${resultLimit} Unicode code points using the ${JSON.stringify(bounds.toolResults.strategy)} strategy.`,
      recordIndex,
      ...event.inputLine ? { inputLine: event.inputLine } : {}
    });
  }
  const record = {
    role: "tool",
    tool_call_id: finalId,
    content
  };
  return record;
}
function buildMeta(context, modelCounts) {
  let model = context.model;
  if (!model) {
    let best;
    let highestCount = 0;
    for (const [candidate, count] of modelCounts) {
      if (count > highestCount || count === highestCount && best !== undefined && candidate < best) {
        best = candidate;
        highestCount = count;
      }
    }
    model = best;
  }
  return {
    role: "meta",
    source: context.source,
    ...context.cwd ? { cwd: context.cwd } : {},
    ...context.gitBranch ? { git_branch: context.gitBranch } : {},
    ...model ? { model } : {}
  };
}
function fillTimestamps(count, anchors, context, diagnostics) {
  if (count === 0)
    return [];
  if (anchors.size === 0) {
    const baseMs = (context.createdAt ?? new Date(SYNTH_BASE_MS)).getTime();
    const stepSeconds = context.durationSeconds && count > 1 ? context.durationSeconds / (count - 1) : SYNTH_STEP_SECONDS;
    diagnostics.push({
      code: "timestamps_synthesized",
      message: `Synthesized timestamps for ${count} normalized records.`,
      count
    });
    return Array.from({ length: count }, (_, index) => new Date(baseMs + stepSeconds * 1000 * index).toISOString());
  }
  const output = new Array(count);
  const indexes = [...anchors.keys()].sort((a, b) => a - b);
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (first === undefined || last === undefined)
    return output;
  const anchorMs = (index) => {
    const anchor = anchors.get(index);
    if (!anchor) {
      throw new NormalizationError("invalid_normalized_transcript", `Missing timestamp anchor at record ${index}.`);
    }
    return anchor.getTime();
  };
  for (let index = 0;index < first; index += 1) {
    output[index] = new Date(anchorMs(first) - (first - index) * 1000).toISOString();
  }
  for (let cursor = 0;cursor + 1 < indexes.length; cursor += 1) {
    const start = indexes[cursor];
    const end = indexes[cursor + 1];
    if (start === undefined || end === undefined)
      continue;
    output[start] = new Date(anchorMs(start)).toISOString();
    const spanMs = anchorMs(end) - anchorMs(start);
    const gap = end - start;
    for (let index = start + 1;index < end; index += 1) {
      output[index] = new Date(anchorMs(start) + spanMs * (index - start) / gap).toISOString();
    }
  }
  output[last] = new Date(anchorMs(last)).toISOString();
  for (let index = last + 1;index < count; index += 1) {
    output[index] = new Date(anchorMs(last) + (index - last) * 1000).toISOString();
  }
  const interpolatedCount = count - anchors.size;
  if (interpolatedCount > 0) {
    diagnostics.push({
      code: "timestamps_interpolated",
      message: `Interpolated timestamps for ${interpolatedCount} normalized records.`,
      count: interpolatedCount
    });
  }
  return output;
}
function shrinkArgs(rawInput, limit) {
  const raw = rawInput || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    const full = JSON.stringify({ _raw: raw });
    const wrapped = limit === null ? full : wrapRawArgs(raw, limit);
    return {
      args: wrapped,
      reshaped: true,
      truncated: wrapped !== full
    };
  }
  if (limit === null || codePointLength(raw) <= limit) {
    return { args: raw, reshaped: false, truncated: false };
  }
  const legacy = shrinkObjectArgsLegacy(parsed, limit);
  if (codePointLength(legacy) <= limit) {
    return { args: legacy, reshaped: false, truncated: true };
  }
  const fresh = JSON.parse(raw);
  const serialized = shrinkObjectArgsSafely(fresh, limit);
  if (codePointLength(serialized) > limit) {
    return {
      args: wrapRawArgs(raw, limit),
      reshaped: true,
      truncated: true
    };
  }
  return { args: serialized, reshaped: false, truncated: true };
}
function shrinkObjectArgsLegacy(parsed, limit) {
  const leaves = [];
  collectStringLeaves(parsed, leaves);
  let serialized = JSON.stringify(parsed);
  const seen = new Set;
  while (codePointLength(serialized) > limit && leaves.length > 0) {
    if (seen.has(serialized))
      break;
    seen.add(serialized);
    let largest = leaves[0];
    if (!largest)
      break;
    for (const leaf of leaves) {
      if (codePointLength(leafValue(leaf)) > codePointLength(leafValue(largest))) {
        largest = leaf;
      }
    }
    const value = leafValue(largest);
    const valueLength = codePointLength(value);
    if (valueLength <= ARGS_LEAF_FLOOR)
      break;
    const keep = Math.max(ARGS_LEAF_FLOOR, Math.floor(valueLength / 2));
    setLeafValue(largest, sliceCodePoints(value, 0, keep) + truncationMarker(valueLength - keep));
    serialized = JSON.stringify(parsed);
  }
  return serialized;
}
function shrinkObjectArgsSafely(parsed, limit) {
  const leaves = [];
  collectStringLeaves(parsed, leaves);
  let serialized = JSON.stringify(parsed);
  while (codePointLength(serialized) > limit && leaves.length > 0) {
    let largest = leaves.find((leaf) => leaf.currentLength > 0);
    if (!largest)
      break;
    for (const leaf of leaves) {
      if (leaf.currentLength > largest.currentLength)
        largest = leaf;
    }
    const previousLength = codePointLength(serialized);
    const overflow = previousLength - limit;
    let candidate = "";
    let nextKeep = 0;
    if (largest.keep > 0) {
      const preferredFloor = largest.keep > ARGS_LEAF_FLOOR ? ARGS_LEAF_FLOOR : 0;
      const markerBudget = codePointLength(truncationMarker(codePointLength(largest.original)));
      nextKeep = Math.max(preferredFloor, Math.min(Math.floor(largest.keep / 2), largest.keep - overflow - markerBudget - 1));
      nextKeep = Math.max(0, Math.min(nextKeep, largest.keep - 1));
      candidate = sliceCodePoints(largest.original, 0, nextKeep) + truncationMarker(codePointLength(largest.original) - nextKeep);
      if (codePointLength(candidate) >= largest.currentLength) {
        candidate = "";
        nextKeep = 0;
      }
    }
    setLeafValue(largest, candidate);
    largest.keep = nextKeep;
    largest.currentLength = codePointLength(candidate);
    serialized = JSON.stringify(parsed);
    if (codePointLength(serialized) >= previousLength && candidate) {
      setLeafValue(largest, "");
      largest.keep = 0;
      largest.currentLength = 0;
      serialized = JSON.stringify(parsed);
    }
  }
  return serialized;
}
function collectStringLeaves(value, leaves) {
  if (Array.isArray(value)) {
    for (let index = 0;index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === "string") {
        leaves.push({
          parent: value,
          key: index,
          original: child,
          keep: codePointLength(child),
          currentLength: codePointLength(child)
        });
      } else if (child !== null && typeof child === "object") {
        collectStringLeaves(child, leaves);
      }
    }
    return;
  }
  if (!isPlainObject(value))
    return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      leaves.push({
        parent: value,
        key,
        original: child,
        keep: codePointLength(child),
        currentLength: codePointLength(child)
      });
    } else if (child !== null && typeof child === "object") {
      collectStringLeaves(child, leaves);
    }
  }
}
function setLeafValue(leaf, value) {
  if (Array.isArray(leaf.parent))
    leaf.parent[leaf.key] = value;
  else
    leaf.parent[leaf.key] = value;
}
function leafValue(leaf) {
  const value = Array.isArray(leaf.parent) ? leaf.parent[leaf.key] : leaf.parent[leaf.key];
  return typeof value === "string" ? value : "";
}
function wrapRawArgs(raw, limit) {
  const full = JSON.stringify({ _raw: raw });
  if (codePointLength(full) <= limit)
    return full;
  let low = 0;
  const rawLength = codePointLength(raw);
  let high = Math.min(rawLength, limit);
  let best = "{}";
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      _raw: sliceCodePoints(raw, 0, keep) + truncationMarker(rawLength - keep)
    });
    if (codePointLength(candidate) <= limit) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function truncateText(text, limit, strategy) {
  const textLength = codePointLength(text);
  if (textLength <= limit)
    return text;
  let low = 0;
  let high = Math.min(textLength - 1, limit);
  let keep = -1;
  let marker = "";
  while (low <= high) {
    const candidateKeep = Math.floor((low + high) / 2);
    const candidateMarker = truncationMarker(textLength - candidateKeep);
    if (candidateKeep + codePointLength(candidateMarker) <= limit) {
      keep = candidateKeep;
      marker = candidateMarker;
      low = candidateKeep + 1;
    } else {
      high = candidateKeep - 1;
    }
  }
  if (keep < 0) {
    marker = sliceCodePoints("…", 0, limit);
    keep = limit - codePointLength(marker);
  }
  if (strategy === "head") {
    return sliceCodePoints(text, 0, keep) + marker;
  }
  const headLength = Math.ceil(keep / 2);
  const tailLength = keep - headLength;
  return sliceCodePoints(text, 0, headLength) + marker + (tailLength > 0 ? sliceCodePoints(text, textLength - tailLength, textLength) : "");
}
function truncationMarker(remaining) {
  return `
… [truncated, ${remaining} more chars]`;
}
function codePointLength(text) {
  let length = 0;
  for (const _character of text)
    length += 1;
  return length;
}
function sliceCodePoints(text, start, end) {
  const stop = end ?? Number.POSITIVE_INFINITY;
  let result = "";
  let index = 0;
  for (const character of text) {
    if (index >= stop)
      break;
    if (index >= start)
      result += character;
    index += 1;
  }
  return result;
}

// src/deepagents-checkpoint.ts
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
var MAX_HELPER_OUTPUT_BYTES = 64 * 1024 * 1024;
async function loadDeepAgentsCheckpoint(checkpoint) {
  validateLocation(checkpoint);
  const python = checkpoint.pythonExecutable ?? process.env.PYTHON ?? "python3";
  const helper = resolveHelperPath();
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [helper], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const fail2 = (error) => {
      if (settled)
        return;
      settled = true;
      reject(error);
    };
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        fail2(new NormalizationError("python_unavailable", `Could not execute Python interpreter ${JSON.stringify(python)}. ` + "Pass checkpoint.pythonExecutable or set PYTHON."));
        return;
      }
      fail2(new NormalizationError("checkpoint_read_failed", `Could not start the Deep Agents checkpoint helper: ${error.message}`));
    });
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill();
        fail2(new NormalizationError("checkpoint_read_failed", "Deep Agents checkpoint helper output exceeded 64 MiB."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      if (settled)
        return;
      settled = true;
      const raw = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new NormalizationError("checkpoint_read_failed", `Deep Agents checkpoint helper failed${detail ? `: ${detail}` : ` with exit code ${code}`}.`));
        return;
      }
      let response;
      try {
        response = JSON.parse(raw);
      } catch {
        reject(new NormalizationError("checkpoint_read_failed", "Deep Agents checkpoint helper returned invalid JSON."));
        return;
      }
      if (isHelperFailure(response)) {
        reject(new NormalizationError(response.code, response.message));
        return;
      }
      if (!isHelperSuccess(response)) {
        reject(new NormalizationError("invalid_checkpoint_state", "Deep Agents checkpoint helper returned an invalid message envelope."));
        return;
      }
      resolve({ ...response.data, threadId: checkpoint.threadId });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({
      path: checkpoint.path,
      threadId: checkpoint.threadId,
      checkpointNamespace: checkpoint.checkpointNamespace ?? "",
      ...checkpoint.checkpointId ? { checkpointId: checkpoint.checkpointId } : {}
    }));
  });
}
function validateLocation(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint location must be an object.");
  }
  if (typeof checkpoint.path !== "string" || !checkpoint.path) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.path is required.");
  }
  if (typeof checkpoint.threadId !== "string" || !checkpoint.threadId) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.threadId is required because the SDK has no standard thread.");
  }
  if (checkpoint.checkpointNamespace !== undefined && typeof checkpoint.checkpointNamespace !== "string") {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.checkpointNamespace must be a string.");
  }
  if (checkpoint.checkpointId !== undefined && (typeof checkpoint.checkpointId !== "string" || !checkpoint.checkpointId)) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.checkpointId must be a non-empty string.");
  }
  if (checkpoint.pythonExecutable !== undefined && (typeof checkpoint.pythonExecutable !== "string" || !checkpoint.pythonExecutable)) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.pythonExecutable must be a non-empty string.");
  }
}
function resolveHelperPath() {
  const candidates = [
    fileURLToPath(new URL("../helpers/deepagents_checkpoint.py", import.meta.url)),
    fileURLToPath(new URL("./deepagents_checkpoint.py", import.meta.url))
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {}
  }
  throw new NormalizationError("checkpoint_read_failed", "The Deep Agents checkpoint helper is missing from this trajectory installation.");
}
function isObject3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHelperFailure(value) {
  return isObject3(value) && value.ok === false && typeof value.code === "string" && typeof value.message === "string";
}
function isHelperSuccess(value) {
  return isObject3(value) && value.ok === true && isCheckpointData(value.data);
}
function isCheckpointData(value) {
  return isObject3(value) && typeof value.checkpointId === "string" && typeof value.checkpointNamespace === "string" && typeof value.checkpointTimestamp === "string" && (value.cwd === undefined || typeof value.cwd === "string") && (value.model === undefined || typeof value.model === "string") && Array.isArray(value.messages) && value.messages.every(isMessageData);
}
function isMessageData(value) {
  if (!isObject3(value) || typeof value.content !== "string")
    return false;
  if (value.timestamp !== undefined && typeof value.timestamp !== "string") {
    return false;
  }
  if (value.role === "human")
    return true;
  if (value.role === "ai")
    return isAIData(value);
  if (value.role === "tool")
    return typeof value.toolCallId === "string";
  return false;
}
function isAIData(value) {
  return Array.isArray(value.reasoning) && value.reasoning.every((item) => typeof item === "string") && Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall) && (value.model === undefined || typeof value.model === "string");
}
function isToolCall(value) {
  return isObject3(value) && "args" in value && (value.id === undefined || typeof value.id === "string") && (value.name === undefined || typeof value.name === "string");
}

// src/index.ts
var ADAPTERS = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  hermes: hermesAdapter,
  letta: lettaAdapter,
  openhands: openHandsAdapter
};
function decodeTranscript(input) {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (typeof input.transcript !== "string") {
    throw new NormalizationError("invalid_input", "Input transcript must be a string containing the source transcript.");
  }
  const adapter = ADAPTERS[input.source];
  if (!adapter) {
    throw new NormalizationError("unknown_source", `Unknown trajectory source ${JSON.stringify(input.source)}. Supported sources: ${Object.keys(ADAPTERS).join(", ")}.`);
  }
  return { decoded: adapter.decode(input.transcript), bounds: resolveBounds(input.bounds) };
}
function normalizeTranscript(input) {
  const { decoded, bounds } = decodeTranscript(input);
  return normalizeDecodedSession(decoded, bounds);
}
async function normalizeCheckpoint(input) {
  const { decoded, bounds } = await decodeCheckpoint(input);
  return normalizeDecodedSession(decoded, bounds);
}
async function decodeCheckpoint(input) {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (input.source !== "deepagents") {
    throw new NormalizationError("unknown_source", `Checkpoint source must be "deepagents"; received ${JSON.stringify(input.source)}.`);
  }
  const checkpoint = await loadDeepAgentsCheckpoint(input.checkpoint);
  return {
    decoded: decodeDeepAgentsCheckpoint(checkpoint),
    bounds: resolveBounds(input.bounds)
  };
}

// src/python-cli.ts
var PROTOCOL_VERSION = 1;
async function main() {
  const request = parseRequest(readFileSync(0, "utf8"));
  const results = [];
  for (const input of request.requests) {
    try {
      const result = input !== null && typeof input === "object" && "source" in input && input.source === "deepagents" ? await normalizeCheckpoint(input) : normalizeTranscript(input);
      results.push({
        ok: true,
        result
      });
    } catch (error) {
      if (error instanceof NormalizationError) {
        results.push({
          ok: false,
          error: {
            name: error.name,
            code: error.code,
            message: error.message
          }
        });
        continue;
      }
      results.push({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
  writeFileSync(1, JSON.stringify({ version: PROTOCOL_VERSION, results }));
}
function parseRequest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Trajectory bridge input must be valid JSON.");
  }
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== PROTOCOL_VERSION || !("requests" in value) || !Array.isArray(value.requests)) {
    throw new Error(`Trajectory bridge input must contain version ${PROTOCOL_VERSION} and a requests array.`);
  }
  return value;
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`trajectory bridge: ${message}
`);
  process.exitCode = 1;
});
