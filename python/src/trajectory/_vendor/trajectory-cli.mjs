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

// src/adapters/atif/index.ts
var SUPPORTED_SCHEMA_VERSIONS = new Set(Array.from({ length: 8 }, (_, index) => `ATIF-v1.${index}`));
var atifAdapter = {
  source: "atif",
  decode(transcript) {
    const document = parseAtifDocument(transcript);
    const diagnostics = [];
    const events = [];
    const trajectoryId = nonemptyString(document.trajectory_id);
    const sessionId = nonemptyString(document.session_id);
    const rootModel = nonemptyString(document.agent.model_name);
    for (let index = 0;index < document.steps.length; index += 1) {
      const step = document.steps[index];
      if (!isObject(step))
        throw invalidAtifTranscript();
      const expectedStepId = index + 1;
      if (step.step_id !== expectedStepId)
        throw invalidAtifTranscript();
      if (step.source !== "system" && step.source !== "user" && step.source !== "agent") {
        throw invalidAtifTranscript();
      }
      if (typeof step.message !== "string" && !Array.isArray(step.message)) {
        throw invalidAtifTranscript();
      }
      const timestamp = parseTimestamp(step.timestamp);
      const model = step.source === "agent" ? nonemptyString(step.model_name) ?? rootModel : undefined;
      const sourceRecordId = trajectoryId ? `trajectory:${trajectoryId}:step:${expectedStepId}` : `step:${expectedStepId}`;
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          sourceRecordId,
          sourceSequence: expectedStepId,
          componentIndex: componentIndex++
        });
      };
      const shared = {
        ...timestamp ? { timestamp } : {},
        ...model ? { model } : {}
      };
      if (step.source === "user") {
        emit({
          type: "message",
          role: "user",
          content: atifContent(step.message),
          ...shared
        });
        continue;
      }
      if (step.source === "system") {
        emit({
          type: "message",
          role: "system",
          content: atifContent(step.message),
          ...shared
        });
      } else {
        if (typeof step.reasoning_content === "string") {
          emit({
            type: "reasoning",
            content: step.reasoning_content,
            ...shared
          });
        }
        emit({
          type: "message",
          role: "assistant",
          content: atifContent(step.message),
          ...shared
        });
        if (step.tool_calls != null && !Array.isArray(step.tool_calls)) {
          throw invalidAtifTranscript();
        }
        for (const rawCall of step.tool_calls ?? []) {
          if (!isObject(rawCall))
            throw invalidAtifTranscript();
          const callId = nonemptyString(rawCall.tool_call_id);
          const name = nonemptyString(rawCall.function_name);
          emit({
            type: "tool_call",
            args: jsonString(rawCall.arguments),
            ...callId ? { id: callId } : {},
            ...name ? { name } : {},
            ...shared
          });
        }
      }
      if (step.observation == null)
        continue;
      if (!isObject(step.observation) || !Array.isArray(step.observation.results)) {
        throw invalidAtifTranscript();
      }
      for (const rawResult of step.observation.results) {
        if (!isObject(rawResult))
          throw invalidAtifTranscript();
        const callId = nonemptyString(rawResult.source_call_id);
        const content = observationContent(rawResult);
        emit(callId ? { type: "tool_result", callId, content, ...shared } : { type: "observation", content, ...shared });
      }
    }
    if (Array.isArray(document.subagent_trajectories) && document.subagent_trajectories.length > 0) {
      diagnostics.push({
        code: "noise_record_dropped",
        message: `Did not flatten ${document.subagent_trajectories.length} embedded ATIF subagent trajectory(ies); only root steps are normalized.`,
        count: document.subagent_trajectories.length
      });
    }
    const createdAt = document.steps.map((step) => isObject(step) ? parseTimestamp(step.timestamp) : undefined).find((value) => value !== undefined);
    const sourceGroupId = sessionId ?? trajectoryId;
    return {
      events,
      context: {
        source: "atif",
        ...rootModel ? { model: rootModel } : {},
        ...createdAt ? { createdAt } : {},
        ...sourceGroupId ? { sourceGroupId } : { sourceGroupRequired: true }
      },
      diagnostics
    };
  }
};
function parseAtifDocument(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidAtifTranscript();
  }
  if (!isObject(parsed) || typeof parsed.schema_version !== "string" || !SUPPORTED_SCHEMA_VERSIONS.has(parsed.schema_version) || !isObject(parsed.agent) || typeof parsed.agent.name !== "string" || typeof parsed.agent.version !== "string" || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw invalidAtifTranscript();
  }
  return parsed;
}
function atifContent(value) {
  if (typeof value === "string")
    return value;
  if (Array.isArray(value))
    return blocksText(value);
  return jsonString(value);
}
function observationContent(result) {
  if (result.content != null)
    return atifContent(result.content);
  if (Array.isArray(result.subagent_trajectory_ref)) {
    return jsonString({ subagent_trajectory_ref: result.subagent_trajectory_ref });
  }
  return "";
}
function nonemptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function invalidAtifTranscript() {
  return new NormalizationError("invalid_input", "ATIF transcript must be one ATIF-v1.0 through ATIF-v1.7 JSON trajectory object with agent metadata and sequential steps.");
}

// src/adapters/claude-code/index.ts
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
    const rows = [...parseJsonLines(transcript, diagnostics)];
    const standaloneSidechain = rows.some(({ value }) => isConversationalRecord(value) && value.isSidechain === true) && !rows.some(({ value }) => isConversationalRecord(value) && value.isSidechain !== true);
    let cwdCandidate;
    let branchCandidate;
    const sessionIds = new Set;
    const agentIds = new Set;
    for (const { value: record, line, byteOffset } of rows) {
      const recordType = record.type;
      if (record.isSidechain === true && !standaloneSidechain) {
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
      if (standaloneSidechain && typeof record.agentId === "string" && record.agentId) {
        agentIds.add(record.agentId);
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
            emit(toolResultEvent(blocksText(block.content), typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, typeof block.is_error === "boolean" ? !block.is_error : undefined, line, timestamp));
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
    if (agentIds.size > 1) {
      throw new NormalizationError("source_group_conflict", `Claude Code subagent transcript contains multiple agent ids: ${[...agentIds].map((id) => JSON.stringify(id)).sort().join(", ")}.`);
    }
    const sessionId = sessionIds.size === 1 ? sessionIds.values().next().value : undefined;
    const [agentId] = agentIds;
    const sourceGroupId = agentId ?? sessionId;
    const sourceGroupAmbiguous = sessionIds.size > 1 && !agentId;
    const cwd = cwdCandidate?.value;
    const gitBranch = branchCandidate?.value;
    return {
      events,
      context: {
        source: "claude-code",
        ...cwd ? { cwd } : {},
        ...gitBranch ? { gitBranch } : {},
        ...sourceGroupId ? { sourceGroupId } : {},
        ...sourceGroupAmbiguous ? { sourceGroupAmbiguous: true } : {}
      },
      diagnostics
    };
  }
};
function isConversationalRecord(record) {
  return (record.type === "user" || record.type === "assistant") && isObject(record.message);
}
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
function toolResultEvent(content, callId, ok, inputLine, timestamp) {
  return {
    type: "tool_result",
    content,
    ...typeof ok === "boolean" ? { ok } : {},
    inputLine,
    ...callId ? { callId } : {},
    ...timestamp ? { timestamp } : {}
  };
}

// src/adapters/codex/index.ts
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
        if (role === "system") {
          emit({
            type: "message",
            role: "system",
            content,
            inputLine: line,
            ...timestamp ? { timestamp } : {}
          });
        } else if (role === "user") {
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

// src/adapters/copilot-cli/index.ts
var KNOWN_EVENT_TYPES = new Set([
  "abort",
  "assistant.message",
  "assistant.turn_end",
  "assistant.turn_start",
  "hook.end",
  "hook.start",
  "session.compaction_complete",
  "session.compaction_start",
  "session.info",
  "session.mode_changed",
  "session.model_change",
  "session.plan_changed",
  "session.resume",
  "session.shutdown",
  "session.start",
  "session.task_complete",
  "system.notification",
  "tool.execution_complete",
  "tool.execution_start",
  "user.message"
]);
var copilotCliAdapter = {
  source: "copilot-cli",
  decode(transcript) {
    const diagnostics = [];
    const rows = parseJsonLines(transcript, diagnostics);
    const events = [];
    let recognizedRows = 0;
    let cwd;
    let gitBranch;
    let model;
    let sourceGroupId;
    let createdAt;
    for (const { value: row } of rows) {
      if (typeof row.type !== "string" || !KNOWN_EVENT_TYPES.has(row.type))
        continue;
      const data = isObject(row.data) ? row.data : {};
      if (row.type === "session.start") {
        sourceGroupId ??= nonemptyString2(data.sessionId);
        createdAt ??= parseTimestamp(data.startTime);
        const context = isObject(data.context) ? data.context : {};
        cwd ??= nonemptyString2(context.cwd);
        gitBranch ??= nonemptyString2(context.branch);
      } else if (row.type === "hook.start" && data.hookType === "userPromptSubmitted") {
        const input = isObject(data.input) ? data.input : {};
        sourceGroupId ??= nonemptyString2(input.sessionId);
        cwd ??= nonemptyString2(input.cwd);
      } else if (row.type === "tool.execution_complete") {
        model ??= nonemptyString2(data.model);
      } else if (row.type === "session.model_change") {
        model ??= nonemptyString2(data.newModel);
      } else if (row.type === "session.shutdown") {
        model ??= nonemptyString2(data.currentModel);
      }
    }
    for (const { value: row, line, byteOffset } of rows) {
      const rowType = row.type;
      if (typeof rowType !== "string" || !KNOWN_EVENT_TYPES.has(rowType)) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Copilot CLI event on line ${line}.`,
          inputLine: line
        });
        continue;
      }
      recognizedRows += 1;
      const data = isObject(row.data) ? row.data : {};
      const timestamp = parseTimestamp(row.timestamp);
      const sourceRecordId = nonemptyString2(row.id);
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          ...sourceRecordId ? { sourceRecordId } : { sourceOffset: byteOffset, sourceAnchorKind: "byte" },
          sourceSequence: line - 1,
          componentIndex: componentIndex++,
          inputLine: line
        });
      };
      if (rowType === "hook.start" && data.hookType === "userPromptSubmitted") {
        const input = isObject(data.input) ? data.input : {};
        const promptTimestamp = parseTimestamp(input.timestamp) ?? timestamp;
        emit({
          type: "message",
          role: "user",
          content: typeof input.prompt === "string" ? input.prompt : "",
          ...promptTimestamp ? { timestamp: promptTimestamp } : {}
        });
        continue;
      }
      if (rowType === "assistant.message") {
        const eventModel = nonemptyString2(data.model);
        if (typeof data.reasoningText === "string" && data.reasoningText.trim()) {
          emit({
            type: "reasoning",
            content: data.reasoningText,
            ...timestamp ? { timestamp } : {},
            ...eventModel ? { model: eventModel } : {}
          });
        }
        if (typeof data.content === "string" && data.content.trim()) {
          emit({
            type: "message",
            role: "assistant",
            content: data.content,
            ...timestamp ? { timestamp } : {},
            ...eventModel ? { model: eventModel } : {}
          });
        }
        if (Array.isArray(data.toolRequests)) {
          for (const request of data.toolRequests) {
            if (!isObject(request))
              continue;
            const callId = nonemptyString2(request.toolCallId);
            const name = nonemptyString2(request.name);
            emit({
              type: "tool_call",
              args: typeof request.arguments === "string" ? request.arguments : jsonString(request.arguments),
              ...callId ? { id: callId } : {},
              ...name ? { name } : {},
              ...timestamp ? { timestamp } : {},
              ...eventModel ? { model: eventModel } : {}
            });
          }
        }
        continue;
      }
      if (rowType === "tool.execution_complete") {
        const callId = nonemptyString2(data.toolCallId);
        const eventModel = nonemptyString2(data.model);
        emit({
          type: "tool_result",
          content: copilotResultContent(data),
          ...callId ? { callId } : {},
          ...typeof data.success === "boolean" ? { ok: data.success } : {},
          ...timestamp ? { timestamp } : {},
          ...eventModel ? { model: eventModel } : {}
        });
      }
    }
    if (recognizedRows === 0)
      throw invalidCopilotTranscript();
    return {
      events,
      context: {
        source: "copilot-cli",
        ...cwd ? { cwd } : {},
        ...gitBranch ? { gitBranch } : {},
        ...model ? { model } : {},
        ...sourceGroupId ? { sourceGroupId } : {},
        ...createdAt ? { createdAt } : {}
      },
      diagnostics
    };
  }
};
function nonemptyString2(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function copilotResultContent(data) {
  if (isObject(data.result)) {
    const content = data.result.content;
    if (typeof content === "string")
      return content;
    if (content !== undefined)
      return stringifyContent(content);
  }
  if (isObject(data.error) && typeof data.error.message === "string") {
    return data.error.message;
  }
  if (data.error !== undefined)
    return stringifyContent(data.error);
  return "";
}
function stringifyContent(value) {
  if (typeof value === "string")
    return value;
  if (value === null || value === undefined)
    return "";
  return isObject(value) || Array.isArray(value) ? jsonString(value) : String(value);
}
function invalidCopilotTranscript() {
  return new NormalizationError("invalid_input", "Copilot CLI transcript must be native event JSONL with recognized type and data records.");
}

// src/adapters/cursor/index.ts
var cursorAdapter = {
  source: "cursor",
  decode(transcript) {
    const diagnostics = [];
    const events = [];
    let recognizedRows = 0;
    for (const { value: row, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
      if (row.role !== "user" && row.role !== "assistant" || !isObject(row.message)) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Cursor row on line ${line}.`,
          inputLine: line
        });
        continue;
      }
      recognizedRows += 1;
      const role = row.role;
      const model = typeof row.message.model === "string" && row.message.model ? row.message.model : undefined;
      const content = row.message.content;
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: typeof content === "string" ? content : "" }];
      const sourceRecordId = typeof row.id === "string" && row.id ? row.id : undefined;
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          ...sourceRecordId ? { sourceRecordId } : { sourceOffset: byteOffset, sourceAnchorKind: "byte" },
          sourceSequence: line - 1,
          componentIndex: componentIndex++,
          inputLine: line
        });
      };
      for (const block of blocks) {
        if (!isObject(block))
          continue;
        if (block.type === "text") {
          emit({
            type: "message",
            role,
            content: typeof block.text === "string" ? block.text : "",
            ...model ? { model } : {}
          });
        } else if (block.type === "thinking") {
          emit({
            type: "reasoning",
            content: typeof block.thinking === "string" ? block.thinking : "",
            ...model ? { model } : {}
          });
        } else if (block.type === "tool_use") {
          emit({
            type: "tool_call",
            args: jsonString(block.input),
            ...typeof block.id === "string" && block.id ? { id: block.id } : {},
            ...typeof block.name === "string" && block.name ? { name: block.name } : {},
            ...model ? { model } : {}
          });
        } else if (block.type === "tool_result") {
          emit({
            type: "tool_result",
            content: resultContent(block.content),
            ...typeof block.tool_use_id === "string" && block.tool_use_id ? { callId: block.tool_use_id } : {},
            ...typeof block.is_error === "boolean" ? { ok: !block.is_error } : {},
            ...model ? { model } : {}
          });
        } else {
          diagnostics.push({
            code: "noise_record_dropped",
            message: `Skipped unsupported Cursor content block ${JSON.stringify(block.type)} ` + `on line ${line}.`,
            inputLine: line
          });
        }
      }
    }
    if (recognizedRows === 0)
      throw invalidCursorTranscript();
    return {
      events,
      context: { source: "cursor" },
      diagnostics
    };
  }
};
function resultContent(value) {
  if (typeof value === "string")
    return value;
  if (Array.isArray(value))
    return blocksText(value);
  if (value === null || value === undefined)
    return "";
  return isObject(value) ? jsonString(value) : String(value);
}
function invalidCursorTranscript() {
  return new NormalizationError("invalid_input", "Cursor transcript must be JSONL with role and message.content records.");
}

// src/adapters/droid/index.ts
var TRANSPORT_TYPES2 = new Set([
  "todo_state",
  "session_end",
  "compaction_state"
]);
var droidAdapter = {
  source: "droid",
  decode(transcript) {
    const diagnostics = [];
    const events = [];
    let cwd;
    let sourceGroupId;
    for (const { value: record, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
      const recordType = record.type;
      if (recordType === "session_start") {
        if (sourceGroupId === undefined && typeof record.id === "string" && record.id) {
          sourceGroupId = record.id;
        }
        if (cwd === undefined && typeof record.cwd === "string" && record.cwd) {
          cwd = record.cwd;
        }
        continue;
      }
      if (typeof recordType === "string" && TRANSPORT_TYPES2.has(recordType)) {
        continue;
      }
      if (recordType !== "message" || !isObject(record.message))
        continue;
      const role = record.message.role;
      if (role !== "user" && role !== "assistant")
        continue;
      const blocks = record.message.content;
      if (!Array.isArray(blocks))
        continue;
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          sourceOffset: byteOffset,
          sourceAnchorKind: "byte",
          componentIndex: componentIndex++
        });
      };
      for (const block of blocks) {
        if (!isObject(block))
          continue;
        if (block.type === "thinking") {
          emit({
            type: "reasoning",
            content: typeof block.thinking === "string" ? block.thinking : "",
            inputLine: line
          });
        } else if (block.type === "text") {
          emit({
            type: "message",
            role,
            content: typeof block.text === "string" ? block.text : "",
            inputLine: line
          });
        } else if (block.type === "tool_use" && role === "assistant") {
          emit({
            type: "tool_call",
            args: jsonString(block.input),
            inputLine: line,
            ...typeof block.id === "string" && block.id ? { id: block.id } : {},
            ...typeof block.name === "string" && block.name ? { name: block.name } : {}
          });
        } else if (block.type === "tool_result" && role === "user") {
          emit({
            type: "tool_result",
            content: toolResultContent(block.content, block.is_error === true),
            inputLine: line,
            ...typeof block.tool_use_id === "string" && block.tool_use_id ? { callId: block.tool_use_id } : {}
          });
        }
      }
    }
    return {
      events,
      context: {
        source: "droid",
        ...cwd ? { cwd } : {},
        ...sourceGroupId ? { sourceGroupId } : {}
      },
      diagnostics
    };
  }
};
function toolResultContent(content, isError) {
  const text = typeof content === "string" ? content : blocksText(content);
  return isError && !/^error/i.test(text) ? `Error: ${text}` : text;
}

// src/adapters/gemini-cli/index.ts
var TERMINAL_TOOL_STATUSES = new Set(["cancelled", "error", "success"]);
var geminiCliAdapter = {
  source: "gemini-cli",
  decode(transcript) {
    const document = parseGeminiDocument(transcript);
    const diagnostics = [];
    const events = [];
    for (let messageIndex = 0;messageIndex < document.messages.length; messageIndex += 1) {
      const message = document.messages[messageIndex];
      if (!isObject(message))
        continue;
      const messageType = message.type;
      if (messageType === "info")
        continue;
      const timestamp = parseTimestamp(message.timestamp);
      const model = nonemptyString3(message.model);
      const sourceRecordId = nonemptyString3(message.id);
      let componentIndex = 0;
      const emit = (event) => {
        events.push({
          ...event,
          ...sourceRecordId ? { sourceRecordId } : { sourceOffset: messageIndex, sourceAnchorKind: "ordinal" },
          sourceSequence: messageIndex,
          componentIndex: componentIndex++
        });
      };
      if (messageType === "user") {
        emit({
          type: "message",
          role: "user",
          content: blocksText(message.content),
          ...timestamp ? { timestamp } : {}
        });
        continue;
      }
      if (messageType !== "gemini") {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Gemini CLI message type ${JSON.stringify(messageType)} ` + `at position ${messageIndex + 1}.`
        });
        continue;
      }
      if (Array.isArray(message.thoughts)) {
        for (const thought of message.thoughts) {
          const content2 = thoughtContent(thought);
          if (!content2.trim())
            continue;
          emit({
            type: "reasoning",
            content: content2,
            ...timestamp ? { timestamp } : {},
            ...model ? { model } : {}
          });
        }
      }
      const content = blocksText(message.content);
      if (content.trim()) {
        emit({
          type: "message",
          role: "assistant",
          content,
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      }
      if (!Array.isArray(message.toolCalls))
        continue;
      for (const rawCall of message.toolCalls) {
        if (!isObject(rawCall))
          continue;
        const callId = nonemptyString3(rawCall.id);
        const name = nonemptyString3(rawCall.name);
        const callTimestamp = parseTimestamp(rawCall.timestamp) ?? timestamp;
        emit({
          type: "tool_call",
          args: jsonString(rawCall.args),
          ...callId ? { id: callId } : {},
          ...name ? { name } : {},
          ...callTimestamp ? { timestamp: callTimestamp } : {},
          ...model ? { model } : {}
        });
        const status = nonemptyString3(rawCall.status);
        const outputs = toolOutputs(rawCall.result);
        if (outputs.length === 0 && (!status || !TERMINAL_TOOL_STATUSES.has(status))) {
          continue;
        }
        emit({
          type: "tool_result",
          content: outputs.join(`
`),
          ...callId ? { callId } : {},
          ...status === "success" ? { ok: true } : status === "error" || status === "cancelled" ? { ok: false } : {},
          ...callTimestamp ? { timestamp: callTimestamp } : {},
          ...model ? { model } : {}
        });
      }
    }
    const sourceGroupId = nonemptyString3(document.sessionId);
    const sourceGroupRequired = !sourceGroupId && !nonemptyString3(document.projectHash);
    const createdAt = parseTimestamp(document.startTime);
    return {
      events,
      context: {
        source: "gemini-cli",
        ...sourceGroupId ? { sourceGroupId } : {},
        ...sourceGroupRequired ? { sourceGroupRequired: true } : {},
        ...createdAt ? { createdAt } : {}
      },
      diagnostics
    };
  }
};
function parseGeminiDocument(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidGeminiTranscript();
  }
  if (!isObject(parsed) || !Array.isArray(parsed.messages)) {
    throw invalidGeminiTranscript();
  }
  return parsed;
}
function nonemptyString3(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function thoughtContent(value) {
  if (!isObject(value))
    return String(value ?? "");
  return ["subject", "description"].flatMap((key) => typeof value[key] === "string" && value[key] ? [value[key]] : []).join(" — ");
}
function toolOutputs(value) {
  if (!Array.isArray(value))
    return [];
  const outputs = [];
  for (const item of value) {
    if (!isObject(item) || !isObject(item.functionResponse))
      continue;
    const response = item.functionResponse.response;
    if (!isObject(response))
      continue;
    if (response.output !== undefined) {
      outputs.push(stringContent(response.output));
    } else if (Object.keys(response).length > 0) {
      outputs.push(jsonString(response));
    }
  }
  return outputs;
}
function stringContent(value) {
  if (typeof value === "string")
    return value;
  if (value === null || value === undefined)
    return "";
  return isObject(value) || Array.isArray(value) ? jsonString(value) : String(value);
}
function invalidGeminiTranscript() {
  return new NormalizationError("invalid_input", "Gemini CLI transcript must be one native session JSON document with a messages array.");
}

// src/adapters/hermes/index.ts
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

// src/adapters/letta-code/index.ts
var SUPPORTED_KINDS = new Set([
  "user",
  "assistant",
  "reasoning",
  "tool_call",
  "error"
]);
var lettaCodeAdapter = {
  source: "letta-code",
  decode(transcript) {
    const diagnostics = [];
    const rows = parseJsonLines(transcript, diagnostics);
    const events = [];
    const reasoningRecordIds = new Set;
    let recognizedRows = 0;
    for (const { value: row } of rows) {
      if (row.kind !== "reasoning")
        continue;
      const sourceRecordId = nonemptyString4(row.source_message_id) ?? nonemptyString4(row.source_line_id);
      if (sourceRecordId)
        reasoningRecordIds.add(sourceRecordId);
    }
    for (const { value: row, line } of rows) {
      if (typeof row.kind !== "string" || !SUPPORTED_KINDS.has(row.kind)) {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped unsupported Letta Code transcript row on line ${line}.`,
          inputLine: line
        });
        continue;
      }
      recognizedRows += 1;
      if (row.kind === "error") {
        diagnostics.push({
          code: "noise_record_dropped",
          message: `Skipped Letta Code runtime error row on line ${line}.`,
          inputLine: line
        });
        continue;
      }
      const timestamp = parseTimestamp(row.captured_at);
      const sourceMessageId = nonemptyString4(row.source_message_id);
      const sourceLineId = nonemptyString4(row.source_line_id);
      const sourceRecordId = sourceMessageId ?? sourceLineId;
      const sourceFields = sourceRecordId ? { sourceRecordId } : {
        sourceOffset: line - 1,
        sourceAnchorKind: "ordinal"
      };
      if (row.kind === "user" || row.kind === "assistant" || row.kind === "reasoning") {
        if (typeof row.text !== "string" || row.text.length === 0) {
          diagnostics.push({
            code: "noise_record_dropped",
            message: `Skipped empty Letta Code ${row.kind} row on line ${line}.`,
            inputLine: line
          });
          continue;
        }
        const componentIndex = row.kind === "assistant" && sourceRecordId !== undefined && reasoningRecordIds.has(sourceRecordId) ? 1 : 0;
        if (row.kind === "reasoning") {
          events.push({
            type: "reasoning",
            content: row.text,
            inputLine: line,
            ...sourceFields,
            componentIndex,
            ...timestamp ? { timestamp } : {}
          });
        } else {
          events.push({
            type: "message",
            role: row.kind,
            content: row.text,
            inputLine: line,
            ...sourceFields,
            componentIndex,
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      const callId = sourceLineId ?? sourceMessageId ?? `letta-code-tool-line-${line}`;
      const name = nonemptyString4(row.name);
      events.push({
        type: "tool_call",
        args: nonemptyString4(row.argsText) ?? "{}",
        inputLine: line,
        ...sourceFields,
        componentIndex: 0,
        id: callId,
        ...name ? { name } : {},
        ...timestamp ? { timestamp } : {}
      });
      if (typeof row.resultText === "string" || typeof row.resultOk === "boolean") {
        let content = typeof row.resultText === "string" ? row.resultText : "";
        if (row.resultOk === false && !/^error/i.test(content)) {
          content = `Error: ${content}`;
        }
        events.push({
          type: "tool_result",
          content,
          ...typeof row.resultOk === "boolean" ? { ok: row.resultOk } : {},
          inputLine: line,
          ...sourceFields,
          componentIndex: 1,
          callId,
          ...timestamp ? { timestamp } : {}
        });
      }
    }
    if (recognizedRows === 0) {
      throw invalidLettaCodeTranscript();
    }
    return {
      events,
      context: { source: "letta-code" },
      diagnostics
    };
  }
};
function nonemptyString4(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function invalidLettaCodeTranscript() {
  return new NormalizationError("invalid_input", "Letta Code transcript must be client-side transcript.jsonl with kind-tagged rows.");
}

// src/adapters/pi-session-shared.ts
function decodePiSessionTranscript(transcript, options) {
  const diagnostics = [];
  const events = [];
  const excludedModels = options.excludedModels ?? [];
  let cwd;
  let createdAt;
  let sessionId;
  let sawMessageRow = false;
  for (const { value: row, line, byteOffset } of parseJsonLines(transcript, diagnostics)) {
    if (row.type === "session") {
      if (!cwd && typeof row.cwd === "string" && row.cwd)
        cwd = row.cwd;
      createdAt ??= parseTimestamp(row.timestamp);
      if (!sessionId && typeof row.id === "string" && row.id) {
        sessionId = row.id;
      }
      continue;
    }
    if (row.type !== "message" || !isObject(row.message))
      continue;
    sawMessageRow = true;
    const message = row.message;
    const timestamp = parseTimestamp(row.timestamp) ?? messageTimestamp(message.timestamp);
    const id = typeof row.id === "string" && row.id ? row.id : undefined;
    const model = typeof message.model === "string" && message.model && !excludedModels.includes(message.model) ? message.model : undefined;
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
          inputLine: line,
          ...timestamp ? { timestamp } : {}
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        if (message.content) {
          emit({
            type: "message",
            role: "assistant",
            content: message.content,
            inputLine: line,
            ...timestamp ? { timestamp } : {},
            ...model ? { model } : {}
          });
        }
        continue;
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isObject(part))
          continue;
        if (part.type === "thinking" && typeof part.thinking === "string") {
          emit({
            type: "reasoning",
            content: part.thinking,
            inputLine: line,
            ...timestamp ? { timestamp } : {},
            ...model ? { model } : {}
          });
        } else if (part.type === "text" && typeof part.text === "string") {
          emit({
            type: "message",
            role: "assistant",
            content: part.text,
            inputLine: line,
            ...timestamp ? { timestamp } : {},
            ...model ? { model } : {}
          });
        } else if (part.type === "toolCall") {
          emit({
            type: "tool_call",
            args: toolArguments(part.arguments),
            inputLine: line,
            ...typeof part.id === "string" && part.id ? { id: part.id } : {},
            ...typeof part.name === "string" && part.name ? { name: part.name } : {},
            ...timestamp ? { timestamp } : {},
            ...model ? { model } : {}
          });
        }
      }
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool") {
      let content = blocksText(message.content);
      if (message.isError === true && !/^error/i.test(content)) {
        content = `Error: ${content}`;
      }
      emit({
        type: "tool_result",
        content,
        ...typeof message.isError === "boolean" ? { ok: !message.isError } : {},
        inputLine: line,
        ...typeof message.toolCallId === "string" && message.toolCallId ? { callId: message.toolCallId } : {},
        ...timestamp ? { timestamp } : {}
      });
    }
  }
  if (!sawMessageRow && sessionId === undefined) {
    throw new NormalizationError("invalid_input", `${options.sourceLabel} transcript must be session JSONL containing a session header or message entries.`);
  }
  return {
    events,
    context: {
      source: options.source,
      ...cwd ? { cwd } : {},
      ...createdAt ? { createdAt } : {},
      ...sessionId ? { sourceGroupId: sessionId } : {}
    },
    diagnostics
  };
}
function messageTimestamp(value) {
  return parseTimestamp(value);
}
function toolArguments(value) {
  if (typeof value === "string" && value)
    return value;
  return jsonString(value);
}

// src/adapters/openclaw/index.ts
var DELIVERY_MIRROR_MODEL = "delivery-mirror";
var openClawAdapter = {
  source: "openclaw",
  decode(transcript) {
    return decodePiSessionTranscript(transcript, {
      source: "openclaw",
      sourceLabel: "OpenClaw",
      excludedModels: [DELIVERY_MIRROR_MODEL]
    });
  }
};

// src/adapters/openhands/index.ts
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
      if (callId) {
        emit({
          type: "tool_result",
          content: result,
          ...toolResultStatus(event),
          callId,
          ...timestamp ? { timestamp } : {}
        });
      } else {
        emit({
          type: "observation",
          content: result,
          ...timestamp ? { timestamp } : {}
        });
      }
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
function toolResultStatus(event) {
  if (event.kind !== "ObservationEvent" || !isObject(event.observation))
    return {};
  return typeof event.observation.is_error === "boolean" ? { ok: !event.observation.is_error } : {};
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

// src/adapters/opencode/index.ts
var TRANSPORT_PART_TYPES = new Set([
  "file",
  "patch",
  "snapshot",
  "step-finish",
  "step-start",
  "subtask"
]);
var openCodeAdapter = {
  source: "opencode",
  decode(transcript) {
    const document = parseOpenCodeDocument(transcript);
    const diagnostics = [];
    const events = [];
    const sessionInfo = isObject(document.info) ? document.info : {};
    let partOrdinal = 0;
    for (let messageIndex = 0;messageIndex < document.messages.length; messageIndex += 1) {
      const message = document.messages[messageIndex];
      if (!isObject(message))
        continue;
      const info = isObject(message.info) ? message.info : {};
      const role = info.role;
      const messageId = nonemptyString5(info.id);
      const timestamp = parseTimestamp(isObject(info.time) ? info.time.created : undefined);
      const model = nonemptyString5(info.modelID);
      const parts = Array.isArray(message.parts) ? message.parts : [];
      let messageComponentIndex = 0;
      let latestTimestamp;
      const orderedTimestamp = (candidate) => {
        if (!candidate)
          return latestTimestamp;
        if (latestTimestamp && candidate.getTime() < latestTimestamp.getTime()) {
          return latestTimestamp;
        }
        latestTimestamp = candidate;
        return candidate;
      };
      for (const part of parts) {
        const ordinal = partOrdinal++;
        if (!isObject(part))
          continue;
        const partId = nonemptyString5(part.id);
        const sourceRecordId = partId ?? messageId;
        let partComponentIndex = 0;
        const emit = (event) => {
          const componentIndex = partId ? partComponentIndex++ : messageId ? messageComponentIndex++ : partComponentIndex++;
          events.push({
            ...event,
            ...sourceRecordId ? { sourceRecordId } : { sourceOffset: ordinal, sourceAnchorKind: "ordinal" },
            sourceSequence: ordinal,
            componentIndex
          });
        };
        if (part.type === "text") {
          if (role !== "user" && role !== "assistant")
            continue;
          const partTime = isObject(part.time) ? part.time : {};
          const eventTimestamp = orderedTimestamp(parseTimestamp(partTime.start) ?? timestamp);
          emit({
            type: "message",
            role,
            content: stringContent2(part.text),
            ...eventTimestamp ? { timestamp: eventTimestamp } : {},
            ...model ? { model } : {}
          });
          continue;
        }
        if (part.type === "reasoning") {
          const partTime = isObject(part.time) ? part.time : {};
          const eventTimestamp = orderedTimestamp(parseTimestamp(partTime.start) ?? timestamp);
          emit({
            type: "reasoning",
            content: stringContent2(part.text),
            ...eventTimestamp ? { timestamp: eventTimestamp } : {},
            ...model ? { model } : {}
          });
          continue;
        }
        if (part.type === "tool") {
          const state = isObject(part.state) ? part.state : {};
          const stateTime = isObject(state.time) ? state.time : {};
          const callTimestamp = orderedTimestamp(parseTimestamp(stateTime.start) ?? timestamp);
          const resultTimestamp = orderedTimestamp(parseTimestamp(stateTime.end) ?? callTimestamp);
          const callId = nonemptyString5(part.callID);
          const name = nonemptyString5(part.tool);
          emit({
            type: "tool_call",
            args: jsonString(state.input),
            ...callId ? { id: callId } : {},
            ...name ? { name } : {},
            ...callTimestamp ? { timestamp: callTimestamp } : {},
            ...model ? { model } : {}
          });
          const status = nonemptyString5(state.status);
          const output = state.output !== undefined ? stringContent2(state.output) : status === "error" ? errorContent(state.error) : undefined;
          if (output !== undefined) {
            emit({
              type: "tool_result",
              content: output,
              ...callId ? { callId } : {},
              ...status === "completed" ? { ok: true } : status === "error" ? { ok: false } : {},
              ...resultTimestamp ? { timestamp: resultTimestamp } : {},
              ...model ? { model } : {}
            });
          }
          continue;
        }
        if (typeof part.type === "string" && !TRANSPORT_PART_TYPES.has(part.type)) {
          diagnostics.push({
            code: "noise_record_dropped",
            message: `Skipped unsupported OpenCode part type ${JSON.stringify(part.type)} ` + `in message ${messageIndex + 1}.`
          });
        }
      }
    }
    const cwd = nonemptyString5(sessionInfo.directory);
    const sourceGroupId = nonemptyString5(sessionInfo.id);
    const createdAt = parseTimestamp(isObject(sessionInfo.time) ? sessionInfo.time.created : undefined);
    return {
      events,
      context: {
        source: "opencode",
        ...cwd ? { cwd } : {},
        ...sourceGroupId ? { sourceGroupId } : {},
        ...createdAt ? { createdAt } : {}
      },
      diagnostics
    };
  }
};
function parseOpenCodeDocument(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidOpenCodeTranscript();
  }
  if (!isObject(parsed) || !isObject(parsed.info) || !Array.isArray(parsed.messages)) {
    throw invalidOpenCodeTranscript();
  }
  return parsed;
}
function nonemptyString5(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function stringContent2(value) {
  if (typeof value === "string")
    return value;
  if (value === null || value === undefined)
    return "";
  return isObject(value) || Array.isArray(value) ? jsonString(value) : String(value);
}
function errorContent(value) {
  if (isObject(value) && typeof value.message === "string")
    return value.message;
  return stringContent2(value);
}
function invalidOpenCodeTranscript() {
  return new NormalizationError("invalid_input", "OpenCode transcript must be one JSON document with info and messages arrays of message parts.");
}

// src/adapters/omp/index.ts
var ompAdapter = {
  source: "omp",
  decode(transcript) {
    return decodePiSessionTranscript(transcript, {
      source: "omp",
      sourceLabel: "omp"
    });
  }
};

// src/adapters/pi/index.ts
var piAdapter = {
  source: "pi",
  decode(transcript) {
    return decodePiSessionTranscript(transcript, {
      source: "pi",
      sourceLabel: "pi"
    });
  }
};

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

// src/filters.ts
var DEFAULT_NORMALIZATION_FILTERS = Object.freeze({ toolResults: "include", systemMessages: "omit" });
function resolveFilters(filters) {
  if (filters === undefined)
    return { ...DEFAULT_NORMALIZATION_FILTERS };
  assertObject2(filters, "filters");
  const unknown = Object.keys(filters).find((key) => key !== "toolResults" && key !== "systemMessages");
  if (unknown !== undefined) {
    throw invalidFilters(`filters contains unknown option ${JSON.stringify(unknown)}.`);
  }
  const toolResults = filters.toolResults ?? DEFAULT_NORMALIZATION_FILTERS.toolResults;
  if (toolResults !== "include" && toolResults !== "omit") {
    throw invalidFilters('filters.toolResults must be either "include" or "omit".');
  }
  const systemMessages = filters.systemMessages ?? DEFAULT_NORMALIZATION_FILTERS.systemMessages;
  if (systemMessages !== "include" && systemMessages !== "omit") {
    throw invalidFilters('filters.systemMessages must be either "include" or "omit".');
  }
  return { toolResults, systemMessages };
}
function assertObject2(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidFilters(`${path} must be an object.`);
  }
}
function invalidFilters(message) {
  return new NormalizationError("invalid_input", message);
}

// src/validate.ts
var TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
var META_KEYS = new Set(["role", "source", "cwd", "git_branch", "model"]);
var CONTENT_KEYS = new Set(["role", "content", "timestamp"]);
var ASSISTANT_TOOL_KEYS = new Set(["role", "content", "timestamp", "tool_calls"]);
var TOOL_RESULT_KEYS = new Set(["role", "tool_call_id", "content", "ok", "timestamp"]);
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
    if (record.role === "system" || record.role === "observation" || record.role === "user" || record.role === "reasoning") {
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
      if ("ok" in record && typeof record.ok !== "boolean") {
        fail(`Record ${index}: tool ok must be boolean when present.`);
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
    case "observation":
      return "observation";
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
function normalizeDecodedSession(decoded, bounds, options) {
  const internal = normalizeDecodedSessionInternal(decoded, bounds, options);
  return { records: internal.records, diagnostics: internal.diagnostics };
}
function normalizeDecodedSessionInternal(decoded, bounds, options) {
  const partial = options?.partial ?? false;
  const filters = options?.filters ?? DEFAULT_NORMALIZATION_FILTERS;
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
    const record = normalizeEvent(event, eventIndex, body.length + 1, plan, diagnostics, bounds, filters, partial);
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
    bounds,
    filters
  };
}
function normalizeEvent(event, eventIndex, recordIndex, plan, diagnostics, bounds, filters, partial) {
  if (event.type === "message") {
    if (!event.content.trim()) {
      return;
    }
    if (event.role === "system") {
      if (filters.systemMessages === "omit")
        return;
      const record3 = {
        role: "system",
        content: event.content
      };
      return record3;
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
  if (event.type === "observation") {
    if (!event.content.trim())
      return;
    const record2 = {
      role: "observation",
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
  if (filters.toolResults === "omit")
    return;
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
    content,
    ...typeof event.ok === "boolean" ? { ok: event.ok } : {}
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

// src/adapters/deepagents/index.ts
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var MAX_HELPER_OUTPUT_BYTES = 64 * 1024 * 1024;
async function normalizeCheckpoint(input) {
  const { decoded, bounds, filters } = await decodeCheckpoint(input);
  return normalizeDecodedSession(decoded, bounds, { filters });
}
async function decodeCheckpoint(input) {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (input.source !== "deepagents") {
    throw new NormalizationError("unknown_source", `Checkpoint source must be "deepagents"; received ${JSON.stringify(input.source)}.`);
  }
  const bounds = resolveBounds(input.bounds);
  const filters = resolveFilters(input.filters);
  const checkpoint = await loadDeepAgentsCheckpoint(input.checkpoint);
  return {
    decoded: decodeDeepAgentsCheckpoint(checkpoint),
    bounds,
    filters
  };
}
async function loadDeepAgentsCheckpoint(checkpoint) {
  validateLocation(checkpoint);
  const path = checkpoint.path ?? join(homedir(), ".deepagents", "sessions.db");
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
      path,
      threadId: checkpoint.threadId,
      checkpointNamespace: ""
    }));
  });
}
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
function validateLocation(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint location must be an object.");
  }
  if (typeof checkpoint.threadId !== "string" || !checkpoint.threadId) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.threadId is required; the CLI session picker lists thread ids.");
  }
  if (checkpoint.path !== undefined && (typeof checkpoint.path !== "string" || !checkpoint.path)) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.path must be a non-empty string when provided.");
  }
  if (checkpoint.pythonExecutable !== undefined && (typeof checkpoint.pythonExecutable !== "string" || !checkpoint.pythonExecutable)) {
    throw new NormalizationError("invalid_input", "Deep Agents checkpoint.pythonExecutable must be a non-empty string.");
  }
}
function resolveHelperPath() {
  const candidates = [
    fileURLToPath(new URL("../../../helpers/deepagents_checkpoint.py", import.meta.url)),
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
// src/adapters/claude-code/list.ts
import { homedir as homedir2 } from "node:os";
import { basename, join as join3 } from "node:path";

// src/adapters/listing-shared.ts
import { readdirSync, statSync } from "node:fs";
import { join as join2 } from "node:path";
function sortListings(items) {
  return items.sort((left, right) => {
    const l = left.updatedAt ?? "";
    const r = right.updatedAt ?? "";
    if (l !== r)
      return l < r ? 1 : -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile()
    }));
  } catch {
    return [];
  }
}
function safeStat(path) {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, sizeBytes: stats.size };
  } catch {
    return;
  }
}
function listingFromFile(id, path) {
  const facts = safeStat(path);
  if (!facts)
    return;
  return {
    id,
    path,
    updatedAt: new Date(facts.mtimeMs).toISOString(),
    sizeBytes: facts.sizeBytes
  };
}
function collectFiles(root, extension, depth) {
  if (depth < 0)
    return [];
  const collected = [];
  for (const entry of safeReadDir(root)) {
    const full = join2(root, entry.name);
    if (entry.isFile && entry.name.endsWith(extension)) {
      collected.push(full);
    } else if (entry.isDirectory) {
      collected.push(...collectFiles(full, extension, depth - 1));
    }
  }
  return collected;
}
var dynamicImport = (specifier) => import(specifier);
async function openSqliteReadOnly(path) {
  let moduleError;
  try {
    const sqlite = await dynamicImport("node:sqlite");
    const DatabaseSync = sqlite.DatabaseSync;
    return openWithWalFallback((readOnly) => {
      const database = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
      return {
        all: (sql, ...params) => database.prepare(sql).all(...params),
        close: () => database.close()
      };
    }, path);
  } catch (error) {
    if (error instanceof NormalizationError)
      throw error;
    if (!isModuleMissing(error))
      throw sqliteOpenFailure(path, error);
    moduleError = error;
  }
  try {
    const sqlite = await dynamicImport("bun:sqlite");
    const Database = sqlite.Database;
    return openWithWalFallback((readOnly) => {
      const database = readOnly ? new Database(path, { readonly: true }) : new Database(path);
      return {
        all: (sql, ...params) => database.query(sql).all(...params),
        close: () => database.close()
      };
    }, path);
  } catch (error) {
    if (error instanceof NormalizationError)
      throw error;
    if (isModuleMissing(error)) {
      throw new NormalizationError("listing_unavailable", `Listing this source requires a runtime with built-in SQLite (Node.js 22.5+ or Bun): ${String(moduleError instanceof Error ? moduleError.message : moduleError)}`);
    }
    throw sqliteOpenFailure(path, error);
  }
}
function openWithWalFallback(open, path) {
  let readOnlyError;
  for (const readOnly of [true, false]) {
    let handle;
    try {
      handle = open(readOnly);
      handle.all("SELECT 1");
      return handle;
    } catch (error) {
      try {
        handle?.close();
      } catch {}
      if (readOnly) {
        readOnlyError = error;
        continue;
      }
      throw sqliteOpenFailure(path, readOnlyError ?? error);
    }
  }
  throw sqliteOpenFailure(path, readOnlyError);
}
function sqliteOpenFailure(path, error) {
  return new NormalizationError("invalid_input", `Could not open SQLite store ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`);
}
function isModuleMissing(error) {
  if (error === null || typeof error !== "object")
    return false;
  const code = error.code;
  const message = error.message;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE" || typeof message === "string" && /Cannot find (module|package)|No such built-in module/i.test(message);
}

// src/adapters/claude-code/list.ts
var AGENT_PREFIX = "agent-";
var JSONL_SUFFIX = ".jsonl";
async function listClaudeCodeTrajectories(root) {
  const base = root ?? join3(homedir2(), ".claude", "projects");
  const items = [];
  for (const project of safeReadDir(base)) {
    if (!project.isDirectory)
      continue;
    const projectPath = join3(base, project.name);
    for (const entry of safeReadDir(projectPath)) {
      if (entry.isFile && entry.name.endsWith(JSONL_SUFFIX)) {
        const path = join3(projectPath, entry.name);
        const listing = listingFromFile(agentIdFromFilename(entry.name) ?? basename(entry.name, JSONL_SUFFIX), path);
        if (listing)
          items.push(listing);
        continue;
      }
      if (!entry.isDirectory)
        continue;
      const subagentsRoot = join3(projectPath, entry.name, "subagents");
      for (const path of collectFiles(subagentsRoot, JSONL_SUFFIX, 2)) {
        const agentId = agentIdFromFilename(basename(path));
        if (!agentId)
          continue;
        const listing = listingFromFile(agentId, path);
        if (listing)
          items.push(listing);
      }
    }
  }
  return sortListings(items);
}
function agentIdFromFilename(filename) {
  if (!filename.startsWith(AGENT_PREFIX) || !filename.endsWith(JSONL_SUFFIX)) {
    return;
  }
  const agentId = filename.slice(AGENT_PREFIX.length, -JSONL_SUFFIX.length);
  return agentId || undefined;
}

// src/adapters/codex/list.ts
import { homedir as homedir3 } from "node:os";
import { basename as basename2, join as join4 } from "node:path";
async function listCodexTrajectories(root) {
  const base = root ?? join4(homedir3(), ".codex", "sessions");
  const items = [];
  for (const path of collectFiles(base, ".jsonl", 4)) {
    const listing = listingFromFile(basename2(path, ".jsonl"), path);
    if (listing)
      items.push(listing);
  }
  return sortListings(items);
}

// src/adapters/droid/list.ts
import { homedir as homedir4 } from "node:os";
import { basename as basename3, join as join5 } from "node:path";
async function listDroidTrajectories(root) {
  const base = root ?? join5(homedir4(), ".factory", "sessions");
  const items = [];
  for (const path of collectFiles(base, ".jsonl", 12)) {
    const listing = listingFromFile(basename3(path, ".jsonl"), path);
    if (listing)
      items.push(listing);
  }
  return sortListings(items);
}

// src/adapters/deepagents/list.ts
import { homedir as homedir5 } from "node:os";
import { join as join6 } from "node:path";
async function listDeepAgentsTrajectories(root) {
  const path = resolveStorePath(root);
  if (!safeStat(path))
    return [];
  const database = await openSqliteReadOnly(path);
  try {
    const rows = database.all("SELECT thread_id, MAX(checkpoint_id) AS latest FROM checkpoints " + "WHERE checkpoint_ns = '' GROUP BY thread_id ORDER BY latest DESC, thread_id");
    const items = [];
    for (const row of rows) {
      if (typeof row.thread_id !== "string" || !row.thread_id)
        continue;
      items.push({ id: row.thread_id, path });
    }
    return items;
  } finally {
    database.close();
  }
}
function resolveStorePath(root) {
  if (root === undefined)
    return join6(homedir5(), ".deepagents", "sessions.db");
  return root.endsWith(".db") ? root : join6(root, "sessions.db");
}

// src/adapters/hermes/list.ts
import { homedir as homedir6 } from "node:os";
import { join as join7 } from "node:path";
async function listHermesTrajectories(root) {
  const path = resolveStorePath2(root);
  if (!safeStat(path))
    return [];
  const database = await openSqliteReadOnly(path);
  try {
    const rows = database.all("SELECT id, title, started_at, ended_at FROM sessions");
    const items = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id)
        continue;
      const updated = numeric(row.ended_at) ?? numeric(row.started_at);
      items.push({
        id: row.id,
        path,
        ...updated !== undefined ? { updatedAt: new Date(updated * 1000).toISOString() } : {},
        ...typeof row.title === "string" && row.title ? { title: row.title } : {}
      });
    }
    return sortListings(items);
  } finally {
    database.close();
  }
}
function resolveStorePath2(root) {
  if (root === undefined)
    return join7(homedir6(), ".hermes", "state.db");
  return root.endsWith(".db") ? root : join7(root, "state.db");
}
function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// src/adapters/letta-code/list.ts
import { homedir as homedir7 } from "node:os";
import { join as join8 } from "node:path";
async function listLettaCodeTrajectories(root) {
  const base = root ?? join8(homedir7(), ".letta", "transcripts");
  const items = [];
  for (const agent of safeReadDir(base)) {
    if (!agent.isDirectory)
      continue;
    const agentPath = join8(base, agent.name);
    for (const conversation of safeReadDir(agentPath)) {
      if (!conversation.isDirectory)
        continue;
      const path = join8(agentPath, conversation.name, "transcript.jsonl");
      const listing = listingFromFile(`${agent.name}/${conversation.name}`, path);
      if (listing && (listing.sizeBytes ?? 0) > 0)
        items.push(listing);
    }
  }
  return sortListings(items);
}

// src/adapters/openclaw/list.ts
import { existsSync } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { basename as basename4, join as join9 } from "node:path";
async function listOpenClawTrajectories(root) {
  const base = root ?? defaultStateDir();
  const items = [];
  const agentsPath = join9(base, "agents");
  for (const agent of safeReadDir(agentsPath)) {
    if (!agent.isDirectory)
      continue;
    const sessionsPath = join9(agentsPath, agent.name, "sessions");
    for (const entry of safeReadDir(sessionsPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl"))
        continue;
      const path = join9(sessionsPath, entry.name);
      const listing = listingFromFile(basename4(entry.name, ".jsonl"), path);
      if (listing)
        items.push(listing);
    }
  }
  return sortListings(items);
}
function defaultStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override)
    return override;
  const current = join9(homedir8(), ".openclaw");
  if (existsSync(current))
    return current;
  return join9(homedir8(), ".clawdbot");
}

// src/adapters/openhands/list.ts
import { homedir as homedir9 } from "node:os";
import { join as join10 } from "node:path";
async function listOpenHandsTrajectories(root) {
  const base = root ?? join10(homedir9(), ".openhands", "sessions");
  const items = [];
  for (const entry of safeReadDir(base)) {
    if (!entry.isDirectory)
      continue;
    const path = join10(base, entry.name);
    const facts = safeStat(path);
    items.push({
      id: entry.name,
      path,
      ...facts ? { updatedAt: new Date(facts.mtimeMs).toISOString() } : {}
    });
  }
  return sortListings(items);
}

// src/adapters/pi/list.ts
import { homedir as homedir10 } from "node:os";
import { basename as basename5, join as join11 } from "node:path";
async function listPiTrajectories(root) {
  const base = root ?? defaultAgentDir();
  const items = [];
  const sessionsPath = join11(base, "sessions");
  for (const project of safeReadDir(sessionsPath)) {
    if (!project.isDirectory)
      continue;
    const projectPath = join11(sessionsPath, project.name);
    for (const entry of safeReadDir(projectPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl"))
        continue;
      const path = join11(projectPath, entry.name);
      const listing = listingFromFile(basename5(entry.name, ".jsonl"), path);
      if (listing)
        items.push(listing);
    }
  }
  return sortListings(items);
}
function defaultAgentDir() {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override)
    return override;
  return join11(homedir10(), ".pi", "agent");
}

// src/adapters/omp/list.ts
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir11 } from "node:os";
import { basename as basename6, join as join12 } from "node:path";
async function listOmpTrajectories(root) {
  const items = [];
  const sessionsPath = root ? join12(root, "sessions") : resolveOmpSessionsPath({
    home: homedir11(),
    platform: process.platform,
    env: process.env,
    exists: existsSync2
  });
  for (const project of safeReadDir(sessionsPath)) {
    if (!project.isDirectory)
      continue;
    const projectPath = join12(sessionsPath, project.name);
    for (const entry of safeReadDir(projectPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl"))
        continue;
      const path = join12(projectPath, entry.name);
      const listing = listingFromFile(basename6(entry.name, ".jsonl"), path);
      if (listing)
        items.push(listing);
    }
  }
  return sortListings(items);
}
function resolveOmpSessionsPath(options) {
  const profile = resolveProfile(options.env.OMP_PROFILE, options.env.PI_PROFILE);
  const configRoot = join12(options.home, options.env.PI_CONFIG_DIR || ".omp", ...profile ? ["profiles", profile] : []);
  const agentOverride = profile ? undefined : options.env.PI_CODING_AGENT_DIR?.trim() || undefined;
  const agentDir = agentOverride ?? join12(configRoot, "agent");
  if (agentOverride === undefined && (options.platform === "linux" || options.platform === "darwin")) {
    const xdgData = options.env.XDG_DATA_HOME?.trim();
    if (xdgData) {
      const xdgRoot = join12(xdgData, "omp", ...profile ? ["profiles", profile] : []);
      if (options.exists(xdgRoot))
        return join12(xdgRoot, "sessions");
    }
  }
  return join12(agentDir, "sessions");
}
function resolveProfile(ompProfile, piProfile) {
  const value = (ompProfile !== undefined ? ompProfile : piProfile)?.trim();
  if (!value || value === "default")
    return;
  if (value === "." || value === ".." || value.endsWith(".") || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(value)) {
    return;
  }
  return value;
}

// src/listing.ts
var DEFAULT_LIMIT = 50;
var MAX_LIMIT = 1000;
var LISTERS = {
  "claude-code": listClaudeCodeTrajectories,
  codex: listCodexTrajectories,
  droid: listDroidTrajectories,
  deepagents: listDeepAgentsTrajectories,
  hermes: listHermesTrajectories,
  "letta-code": listLettaCodeTrajectories,
  openclaw: listOpenClawTrajectories,
  openhands: listOpenHandsTrajectories,
  pi: listPiTrajectories,
  omp: listOmpTrajectories
};
async function listTrajectories(input) {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  const lister = LISTERS[input.source];
  if (!lister) {
    throw new NormalizationError(isKnownNormalizationOnlySource(input.source) ? "listing_unavailable" : "unknown_source", isKnownNormalizationOnlySource(input.source) ? `Local trajectory listing is not available for ${JSON.stringify(input.source)}; supply an exported transcript directly to normalizeTranscript().` : `Unknown trajectory source ${JSON.stringify(input.source)}. Supported listing sources: ${Object.keys(LISTERS).join(", ")}.`);
  }
  if (input.root !== undefined && (typeof input.root !== "string" || !input.root)) {
    throw new NormalizationError("invalid_input", "root must be a non-empty string when provided.");
  }
  const limit = resolveLimit2(input.limit);
  const items = await lister(input.root);
  return paginate(items, input.cursor, limit);
}
function isKnownNormalizationOnlySource(source) {
  return source === "atif" || source === "copilot-cli" || source === "cursor" || source === "gemini-cli" || source === "opencode";
}
function resolveLimit2(limit) {
  if (limit === undefined)
    return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new NormalizationError("invalid_input", `limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}
function paginate(items, cursor, limit) {
  let start = 0;
  if (cursor !== undefined) {
    const state = decodeCursor(cursor);
    const index = items.findIndex((item) => item.id === state.id);
    start = index >= 0 ? index + 1 : Math.min(state.i + 1, items.length);
  }
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  const last = page[page.length - 1];
  if (end >= items.length || last === undefined) {
    return { items: page };
  }
  return {
    items: page,
    nextCursor: encodeCursor({ v: 1, id: last.id, i: end - 1 })
  };
}
function encodeCursor(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (parsed === null || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.id !== "string" || !Number.isInteger(parsed.i) || parsed.i < 0) {
    throw invalidCursor();
  }
  return parsed;
}
function invalidCursor() {
  return new NormalizationError("invalid_input", "cursor is not a valid trajectory-listing cursor.");
}

// src/index.ts
var ADAPTERS = {
  atif: atifAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  "copilot-cli": copilotCliAdapter,
  cursor: cursorAdapter,
  droid: droidAdapter,
  "gemini-cli": geminiCliAdapter,
  hermes: hermesAdapter,
  "letta-code": lettaCodeAdapter,
  openclaw: openClawAdapter,
  opencode: openCodeAdapter,
  openhands: openHandsAdapter,
  pi: piAdapter,
  omp: ompAdapter
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
  return {
    decoded: adapter.decode(input.transcript),
    bounds: resolveBounds(input.bounds),
    filters: resolveFilters(input.filters)
  };
}
function normalizeTranscript(input) {
  const { decoded, bounds, filters } = decodeTranscript(input);
  return normalizeDecodedSession(decoded, bounds, {
    partial: isPartialTranscript(input),
    filters
  });
}
function isPartialTranscript(input) {
  return (input.sourceContext?.partial ?? false) || (input.sourceContext?.baseByteOffset ?? 0) > 0;
}

// src/python-cli.ts
var PROTOCOL_VERSION = 1;
async function main() {
  const request = parseRequest(readFileSync(0, "utf8"));
  const results = [];
  for (const input of request.requests) {
    try {
      const result = input !== null && typeof input === "object" && "list" in input ? await listTrajectories(input.list) : input !== null && typeof input === "object" && ("source" in input) && input.source === "deepagents" ? await normalizeCheckpoint(input) : normalizeTranscript(input);
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
