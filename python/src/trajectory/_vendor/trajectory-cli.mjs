// src/python-cli.ts
import { readFileSync, writeFileSync } from "node:fs";

// src/adapters/shared.ts
function parseJsonLines(transcript, diagnostics) {
  const parsed = [];
  const lines = transcript.split(`
`);
  for (let index = 0;index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined || !raw.trim())
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
    parsed.push({ value, line });
  }
  return parsed;
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
    let cwd;
    let gitBranch;
    for (const { value: record, line } of parseJsonLines(transcript, diagnostics)) {
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
      if (!cwd && typeof record.cwd === "string" && record.cwd)
        cwd = record.cwd;
      if (!gitBranch && typeof record.gitBranch === "string" && record.gitBranch) {
        gitBranch = record.gitBranch;
      }
      if (recordType !== "user" && recordType !== "assistant")
        continue;
      if (!isObject(record.message))
        continue;
      const message = record.message;
      const timestamp = parseTimestamp(record.timestamp);
      const model = typeof message.model === "string" ? message.model : undefined;
      const content = message.content;
      if (recordType === "user") {
        if (typeof content === "string") {
          events.push(messageEvent("user", content, line, timestamp));
          continue;
        }
        const textParts = [];
        for (const block of Array.isArray(content) ? content : []) {
          if (!isObject(block))
            continue;
          if (block.type === "tool_result") {
            events.push(toolResultEvent(blocksText(block.content), typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, line, timestamp));
          } else if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "image") {
            textParts.push("[image]");
          }
        }
        if (textParts.length > 0) {
          events.push(messageEvent("user", textParts.join(`
`), line, timestamp));
        }
        continue;
      }
      if (typeof content === "string") {
        if (content.trim()) {
          events.push(messageEvent("assistant", content, line, timestamp, model));
        }
        continue;
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (!isObject(block))
          continue;
        if (block.type === "thinking") {
          events.push(reasoningEvent(typeof block.thinking === "string" ? block.thinking : "", line, timestamp, model));
        } else if (block.type === "text") {
          events.push(messageEvent("assistant", typeof block.text === "string" ? block.text : "", line, timestamp, model));
        } else if (block.type === "tool_use") {
          events.push(toolCallEvent(typeof block.id === "string" ? block.id : undefined, typeof block.name === "string" ? block.name : undefined, jsonString(block.input), line, timestamp, model));
        }
      }
    }
    return {
      events,
      context: {
        source: "claude-code",
        ...cwd ? { cwd } : {},
        ...gitBranch ? { gitBranch } : {}
      },
      diagnostics
    };
  }
};
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
    for (const { value: record, line } of parseJsonLines(transcript, diagnostics)) {
      const recordType = record.type;
      const payload = isObject(record.payload) ? record.payload : {};
      const timestamp = parseTimestamp(record.timestamp);
      const payloadType = payload.type;
      if (recordType === "session_meta") {
        if (!cwd && typeof payload.cwd === "string" && payload.cwd)
          cwd = payload.cwd;
        createdAt ??= parseTimestamp(payload.timestamp) ?? timestamp;
        if (!gitBranch && isObject(payload.git) && typeof payload.git.branch === "string") {
          gitBranch = payload.git.branch;
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
          events.push({
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
            events.push({
              type: "message",
              role: "user",
              content,
              inputLine: line,
              ...timestamp ? { timestamp } : {}
            });
          }
        } else if (role === "assistant") {
          events.push({
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
        events.push({
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
        events.push({
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
        events.push({
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
        events.push({
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
        events.push({
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
        ...createdAt ? { createdAt } : {}
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

// src/types.ts
class NormalizationError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "NormalizationError";
    this.code = code;
  }
}

// src/adapters/langsmith.ts
var langSmithAdapter = {
  source: "langsmith",
  decode(transcript) {
    const runs = parseRuns(transcript).sort(compareRuns);
    const state = {
      events: [],
      history: [],
      pendingCalls: []
    };
    let model;
    let cwd;
    let gitBranch;
    let createdAt;
    for (const { run } of runs) {
      const metadata = runMetadata(run);
      if (Object.hasOwn(metadata, "ls_message_view_exclude"))
        continue;
      model ??= firstString(metadata.ls_model_name, metadata.model);
      cwd ??= firstString(metadata.cwd, metadata.working_directory);
      gitBranch ??= firstString(metadata.git_branch, metadata.gitBranch);
      const start = parseTimestamp(run.start_time);
      const end = parseTimestamp(run.end_time) ?? start;
      createdAt ??= start;
      if (run.run_type === "llm") {
        const runModel = firstString(metadata.ls_model_name, metadata.model, model);
        mergeItems(state, decodeMessages(inputMessages(run.inputs), start, runModel));
        mergeItems(state, decodeMessages(outputMessages(run.outputs), end, runModel, "assistant"));
        continue;
      }
      if (run.run_type === "tool") {
        const result = decodeToolRun(run, end, state.pendingCalls);
        if (result)
          mergeItems(state, [result]);
      }
    }
    return {
      events: state.events,
      context: {
        source: "langsmith",
        ...cwd ? { cwd } : {},
        ...gitBranch ? { gitBranch } : {},
        ...model ? { model } : {},
        ...createdAt ? { createdAt } : {}
      },
      diagnostics: []
    };
  }
};
function parseRuns(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidTranscript();
  }
  const runs = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.runs) ? parsed.runs : undefined;
  if (!runs || runs.length === 0 || !runs.every(isCanonicalRun)) {
    throw invalidTranscript();
  }
  return runs.map((run, index) => ({ run, index }));
}
function isCanonicalRun(value) {
  return isObject(value) && typeof value.id === "string" && typeof value.trace_id === "string" && typeof value.name === "string" && typeof value.run_type === "string" && isObject(value.inputs);
}
function invalidTranscript() {
  return new NormalizationError("invalid_input", "LangSmith transcript must be a non-empty JSON array of canonical Run records or an object with a runs array.");
}
function compareRuns(left, right) {
  const leftOrder = left.run.dotted_order;
  const rightOrder = right.run.dotted_order;
  if (typeof leftOrder === "string" && typeof rightOrder === "string") {
    const order = leftOrder.localeCompare(rightOrder);
    if (order !== 0)
      return order;
  }
  const leftTime = parseTimestamp(left.run.start_time)?.getTime();
  const rightTime = parseTimestamp(right.run.start_time)?.getTime();
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.index - right.index;
}
function runMetadata(run) {
  const extra = isObject(run.extra) ? run.extra : {};
  return isObject(extra.metadata) ? extra.metadata : {};
}
function inputMessages(value) {
  if (!isObject(value))
    return [];
  const messages = [];
  if (value.system !== undefined) {
    messages.push({ role: "system", content: value.system });
  }
  if (value.instructions !== undefined) {
    messages.push({ role: "system", content: value.instructions });
  }
  const candidate = firstNonEmpty(value.messages, value.input, value.prompt);
  if (candidate !== undefined) {
    messages.push(...messageArray(candidate, "user"));
  } else if (Array.isArray(value.prompts)) {
    for (const prompt of value.prompts) {
      if (typeof prompt === "string")
        messages.push({ role: "user", content: prompt });
    }
  }
  return messages;
}
function outputMessages(value) {
  if (!isObject(value)) {
    if (typeof value !== "string")
      return [];
    const streamed = anthropicStreamMessages(value);
    return streamed.length > 0 ? streamed : [{ role: "assistant", content: value }];
  }
  if (Array.isArray(value.generations)) {
    const firstBatch = Array.isArray(value.generations[0]) ? value.generations[0] : value.generations;
    const messages = [];
    for (const generation of firstBatch) {
      if (!isObject(generation))
        continue;
      if (generation.message !== undefined)
        messages.push(generation.message);
      else if (typeof generation.text === "string") {
        messages.push({ role: "assistant", content: generation.text });
      }
    }
    if (messages.length > 0)
      return messages;
  }
  if (Array.isArray(value.choices)) {
    const messages = value.choices.map((choice) => isObject(choice) ? choice.message : undefined).filter((message) => message !== undefined);
    if (messages.length > 0)
      return messages;
  }
  if (Array.isArray(value.messages))
    return value.messages;
  if (isObject(value.message))
    return [value.message];
  if (Array.isArray(value.output))
    return value.output;
  if (typeof value.output === "string") {
    const streamed = anthropicStreamMessages(value.output);
    return streamed.length > 0 ? streamed : [{ role: "assistant", content: value.output }];
  }
  if (isObject(value.output)) {
    if (Array.isArray(value.output.messages))
      return value.output.messages;
    if (isObject(value.output.update) && Array.isArray(value.output.update.messages)) {
      return value.output.update.messages;
    }
  }
  if (value.role !== undefined || value.type === "message")
    return [value];
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return [{ role: "assistant", content: value.content }];
  }
  return [];
}
function anthropicStreamMessages(output) {
  if (!output.includes("event:") || !output.includes(`
data:`))
    return [];
  const blocks = new Map;
  for (const line of output.split(`
`)) {
    if (!line.startsWith("data:"))
      continue;
    const raw = line.slice("data:".length).trim();
    if (!raw || raw === "[DONE]")
      continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(event) || typeof event.index !== "number")
      continue;
    if (event.type === "content_block_start" && isObject(event.content_block)) {
      const content2 = event.content_block;
      if (typeof content2.type !== "string")
        continue;
      blocks.set(event.index, {
        type: content2.type,
        ...typeof content2.text === "string" ? { text: content2.text } : {},
        ...typeof content2.thinking === "string" ? { thinking: content2.thinking } : {},
        ...typeof content2.id === "string" ? { id: content2.id } : {},
        ...typeof content2.name === "string" ? { name: content2.name } : {},
        ...content2.input !== undefined ? { input: content2.input } : {},
        partialJson: ""
      });
      continue;
    }
    if (event.type !== "content_block_delta" || !isObject(event.delta)) {
      continue;
    }
    const delta = event.delta;
    const block = blocks.get(event.index);
    if (!block)
      continue;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      block.text = (block.text ?? "") + delta.text;
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      block.thinking = (block.thinking ?? "") + delta.thinking;
    } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      block.partialJson += delta.partial_json;
    }
  }
  const content = [];
  for (const [, block] of [...blocks].sort(([left], [right]) => left - right)) {
    if (block.type === "text" && block.text) {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && block.thinking) {
      content.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_use",
        ...block.id ? { id: block.id } : {},
        ...block.name ? { name: block.name } : {},
        input: streamedToolInput(block)
      });
    }
  }
  return content.length > 0 ? [{ role: "assistant", content }] : [];
}
function streamedToolInput(block) {
  if (!block.partialJson)
    return block.input ?? {};
  try {
    return JSON.parse(block.partialJson);
  } catch {
    return { _raw: block.partialJson };
  }
}
function messageArray(value, fallbackRole) {
  if (typeof value === "string")
    return [{ role: fallbackRole, content: value }];
  if (isObject(value))
    return [value];
  if (!Array.isArray(value))
    return [];
  if (value.length === 1 && Array.isArray(value[0]))
    return value[0];
  return value;
}
function decodeMessages(messages, timestamp, model, fallbackRole) {
  const items = [];
  for (const message of messages) {
    items.push(...decodeMessage(message, timestamp, model, fallbackRole));
  }
  return items;
}
function decodeMessage(value, timestamp, model, fallbackRole) {
  if (typeof value === "string") {
    return [messageItem(fallbackRole ?? "assistant", value, undefined, 0, timestamp, model)];
  }
  if (!isObject(value))
    return [];
  const constructorClass = constructorName(value);
  const body = isObject(value.kwargs) ? value.kwargs : value;
  const stableId = firstString(body.id, value.id);
  const role = canonicalRole(firstString(body.role, body.type, fallbackRole), constructorClass);
  const type = firstString(body.type, value.type);
  if (type === "function_call") {
    return [toolCallItem(body, stableId, 0, timestamp, model)];
  }
  if (type === "function_call_output") {
    return [toolResultItem(body, stableId, 0, timestamp)];
  }
  if (type === "reasoning") {
    const text = reasoningText(body);
    return text ? [reasoningItem(text, stableId, 0, timestamp, model)] : [];
  }
  if (role === "tool") {
    return [toolResultItem(body, stableId, 0, timestamp)];
  }
  const items = [];
  const content = body.content;
  if (Array.isArray(content)) {
    for (let index = 0;index < content.length; index += 1) {
      const block = content[index];
      if (typeof block === "string") {
        items.push(messageItem(role, block, stableId, index, timestamp, model));
      } else if (isObject(block)) {
        items.push(...decodeContentBlock(block, role, stableId, index, timestamp, model));
      }
    }
  } else {
    const text = contentText(content);
    if (text)
      items.push(messageItem(role, text, stableId, 0, timestamp, model));
  }
  if (role === "assistant" && Array.isArray(body.tool_calls)) {
    for (let index = 0;index < body.tool_calls.length; index += 1) {
      const call = body.tool_calls[index];
      if (isObject(call)) {
        items.push(toolCallItem(call, stableId, index + items.length, timestamp, model));
      }
    }
  }
  return items;
}
function decodeContentBlock(block, role, stableId, index, timestamp, model) {
  const type = block.type;
  if (type === "tool_use" || type === "tool-call" || type === "function_call") {
    return [toolCallItem(block, stableId, index, timestamp, model)];
  }
  if (type === "tool_result" || type === "tool-result" || type === "function_call_output") {
    return [toolResultItem(block, stableId, index, timestamp)];
  }
  if (type === "thinking" || type === "reasoning" || type === "redacted_thinking") {
    const text2 = reasoningText(block);
    return text2 ? [reasoningItem(text2, stableId, index, timestamp, model)] : [];
  }
  if (type === "image" || type === "image_url") {
    return [messageItem(role, "[image]", stableId, index, timestamp, model)];
  }
  const text = contentText(block.text ?? block.content);
  return text ? [messageItem(role, text, stableId, index, timestamp, model)] : [];
}
function messageItem(role, content, stableId, index, timestamp, model) {
  const canonical = role === "assistant" ? "assistant" : role === "user" ? "user" : role;
  const semanticKey = `message:${canonical}:${jsonString(content)}`;
  const key = stableId ? `message:${stableId}:${index}` : semanticKey;
  if (canonical !== "user" && canonical !== "assistant") {
    return { key, semanticKey };
  }
  return {
    key,
    semanticKey,
    ...stableId ? { stable: true } : {},
    event: {
      type: "message",
      role: canonical,
      content,
      ...timestamp ? { timestamp } : {},
      ...model ? { model } : {}
    }
  };
}
function reasoningItem(content, stableId, index, timestamp, model) {
  return {
    key: stableId ? `reasoning:${stableId}:${index}` : `reasoning:${jsonString(content)}`,
    ...stableId ? { stable: true } : {},
    event: {
      type: "reasoning",
      content,
      ...timestamp ? { timestamp } : {},
      ...model ? { model } : {}
    }
  };
}
function toolCallItem(value, stableId, index, timestamp, model) {
  const fn = isObject(value.function) ? value.function : {};
  const id = value.type === "function_call" ? firstString(value.call_id, value.id, value.toolCallId) : firstString(value.id, value.call_id, value.toolCallId);
  const name = firstString(value.name, value.toolName, fn.name);
  const rawArgs = firstDefined(value.arguments, value.args, value.input, fn.arguments);
  const args = typeof rawArgs === "string" ? rawArgs : jsonString(rawArgs);
  return {
    key: id ? `tool-call:${id}` : `tool-call:${stableId ?? ""}:${index}:${name ?? ""}:${args}`,
    ...id || stableId ? { stable: true } : {},
    event: {
      type: "tool_call",
      args,
      ...id ? { id } : {},
      ...name ? { name } : {},
      ...timestamp ? { timestamp } : {},
      ...model ? { model } : {}
    }
  };
}
function toolResultItem(value, stableId, index, timestamp) {
  const id = firstString(value.tool_call_id, value.tool_use_id, value.call_id, value.toolCallId);
  const raw = firstDefined(value.output, value.result, value.content);
  const content = resultText(raw);
  return {
    key: id ? `tool-result:${id}` : `tool-result:${stableId ?? ""}:${index}:${content}`,
    ...id || stableId ? { stable: true } : {},
    event: {
      type: "tool_result",
      content,
      ...id ? { callId: id } : {},
      ...timestamp ? { timestamp } : {}
    }
  };
}
function decodeToolRun(run, timestamp, pendingCalls) {
  const inputs = isObject(run.inputs) ? run.inputs : {};
  const outputs = isObject(run.outputs) ? run.outputs : {};
  const embedded = embeddedToolMessage(outputs);
  const explicitId = firstString(inputs.toolCallId, inputs.tool_call_id, inputs.call_id, outputs.toolCallId, outputs.tool_call_id, outputs.call_id, embedded?.tool_call_id, embedded?.tool_use_id, embedded?.call_id);
  const name = firstString(inputs.toolName, inputs.tool_name, run.name);
  const call = matchPendingCall(pendingCalls, explicitId, name);
  const callId = explicitId ?? call?.id;
  const rawResult = firstDefined(embedded?.content, embedded?.output, embedded?.result, outputs.result, outputs.output, outputs.content, run.error, Object.keys(outputs).length > 0 ? outputs : undefined);
  if (rawResult === undefined)
    return;
  let content = resultText(rawResult);
  if (run.error && rawResult === run.error && !/^error/i.test(content)) {
    content = `Error: ${content}`;
  }
  return {
    key: callId ? `tool-result:${callId}` : `tool-run:${firstString(run.id) ?? "unknown"}`,
    stable: true,
    event: {
      type: "tool_result",
      content,
      ...callId ? { callId } : {},
      ...timestamp ? { timestamp } : {}
    }
  };
}
function embeddedToolMessage(outputs) {
  const output = isObject(outputs.output) ? outputs.output : undefined;
  const candidate = output ?? (isObject(outputs.message) ? outputs.message : undefined);
  if (!candidate)
    return;
  return isObject(candidate.kwargs) ? candidate.kwargs : candidate;
}
function matchPendingCall(pendingCalls, id, name) {
  let match = id ? pendingCalls.find((call) => !call.consumed && call.id === id) : undefined;
  match ??= name ? pendingCalls.find((call) => !call.consumed && call.name === name) : undefined;
  const remaining = pendingCalls.filter((call) => !call.consumed);
  match ??= remaining.length === 1 ? remaining[0] : undefined;
  if (match)
    match.consumed = true;
  return match;
}
function mergeItems(state, items) {
  if (items.length === 0)
    return;
  let overlap = Math.min(state.history.length, items.length);
  while (overlap > 0) {
    let matches = true;
    const historyStart = state.history.length - overlap;
    for (let index = 0;index < overlap; index += 1) {
      if (!conversationItemsMatch(state.history[historyStart + index], items[index])) {
        matches = false;
        break;
      }
    }
    if (matches)
      break;
    overlap -= 1;
  }
  const repeatedSnapshot = overlap === 0 && items.some((item) => item.stable === true && state.history.some((historyItem) => historyItem.key === item.key));
  for (let index = overlap;index < items.length; index += 1) {
    const item = items[index];
    if (!item)
      continue;
    if (item.stable === true && state.history.some((historyItem) => historyItem.key === item.key)) {
      continue;
    }
    if (repeatedSnapshot && state.history.some((historyItem) => conversationItemsMatch(historyItem, item))) {
      continue;
    }
    state.history.push(item);
    if (!item.event)
      continue;
    if (isDuplicateAdjacentMessage(state.events.at(-1), item.event))
      continue;
    state.events.push(item.event);
    if (item.event.type === "tool_call") {
      state.pendingCalls.push({
        ...item.event.id ? { id: item.event.id } : {},
        ...item.event.name ? { name: item.event.name } : {},
        consumed: false
      });
    } else if (item.event.type === "tool_result" && item.event.callId) {
      matchPendingCall(state.pendingCalls, item.event.callId, undefined);
    }
  }
}
function conversationItemsMatch(previous, current) {
  if (!previous || !current)
    return false;
  if (previous.key === current.key)
    return true;
  return previous.semanticKey !== undefined && previous.semanticKey === current.semanticKey && (previous.stable !== true || current.stable !== true);
}
function isDuplicateAdjacentMessage(previous, current) {
  return previous?.type === "message" && current.type === "message" && previous.role === current.role && previous.content === current.content && previous.timestamp?.getTime() === current.timestamp?.getTime();
}
function canonicalRole(value, constructorClass) {
  if (constructorClass === "HumanMessage" || constructorClass === "ChatMessage") {
    return "user";
  }
  if (constructorClass === "AIMessage")
    return "assistant";
  if (constructorClass === "ToolMessage" || constructorClass === "FunctionMessage") {
    return "tool";
  }
  if (constructorClass === "SystemMessage")
    return "system";
  if (value === "human")
    return "user";
  if (value === "ai")
    return "assistant";
  if (value === "function")
    return "tool";
  return value ?? "assistant";
}
function constructorName(value) {
  if (!Array.isArray(value.id))
    return;
  const last = value.id[value.id.length - 1];
  return typeof last === "string" ? last : undefined;
}
function contentText(value) {
  if (typeof value === "string")
    return value;
  if (value === null || value === undefined)
    return "";
  if (Array.isArray(value))
    return blocksText(value);
  if (isObject(value) && typeof value.value === "string")
    return value.value;
  return "";
}
function reasoningText(value) {
  const direct = firstString(value.thinking, value.text, value.content);
  if (direct)
    return direct;
  if (Array.isArray(value.summary)) {
    return value.summary.map((item) => isObject(item) ? contentText(item.text ?? item.content) : "").filter(Boolean).join(`
`);
  }
  return "";
}
function resultText(value) {
  if (typeof value === "string")
    return value;
  if (value === undefined || value === null)
    return "";
  if (Array.isArray(value))
    return blocksText(value) || jsonString(value);
  if (isObject(value)) {
    if (isObject(value.kwargs))
      return resultText(value.kwargs.content);
    if (typeof value.content === "string")
      return value.content;
  }
  return jsonString(value);
}
function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}
function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0));
}

// src/adapters/letta.ts
var lettaAdapter = {
  source: "letta",
  decode(transcript) {
    const events = [];
    const parsed = parseTranscript(transcript);
    if (parsed.format === "local") {
      for (const entry of parsed.messages) {
        decodeLocalMessage(entry.message, entry.timestamp, events);
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
      if (message.message_type === "user_message" || message.message_type === "assistant_message") {
        const content = blocksText(message.content);
        if (content) {
          events.push({
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
          events.push({
            type: "reasoning",
            content: message.reasoning,
            ...timestamp ? { timestamp } : {}
          });
        }
        continue;
      }
      if (message.message_type === "tool_call_message" || message.message_type === "approval_request_message") {
        for (const call of messageToolCalls(message)) {
          events.push({
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
          events.push({
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
function parseTranscript(transcript) {
  let parsed;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    return parseLocalJsonLines(transcript);
  }
  if (isObject(parsed)) {
    if (parsed.type === "session")
      return parseLocalJsonLines(transcript);
    if (typeof parsed.role === "string") {
      const timestamp = messageTimestamp(parsed);
      return {
        format: "local",
        messages: [
          {
            message: parsed,
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
  for (const raw of transcript.split(`
`)) {
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
    rows.push(row);
  }
  if (rows.length === 0)
    throw invalidLettaTranscript();
  const session = rows.find((row) => row.type === "session");
  if (session) {
    if (session.version !== 3) {
      throw new NormalizationError("invalid_input", `Unsupported Letta local transcript version ${JSON.stringify(session.version)}; supported version: 3.`);
    }
    const createdAt = parseTimestamp(session.timestamp);
    return {
      format: "local",
      messages: rows.flatMap((row) => {
        if (row.type !== "message" || !isObject(row.message))
          return [];
        const timestamp = parseTimestamp(row.timestamp);
        return [
          {
            message: row.message,
            ...timestamp ? { timestamp } : {}
          }
        ];
      }),
      ...createdAt ? { createdAt } : {}
    };
  }
  if (!rows.every((row) => typeof row.role === "string")) {
    throw invalidLettaTranscript();
  }
  return {
    format: "local",
    messages: rows.map((message) => {
      const timestamp = messageTimestamp(message);
      return {
        message,
        ...timestamp ? { timestamp } : {}
      };
    })
  };
}
function decodeLocalMessage(message, entryTimestamp, events) {
  const timestamp = entryTimestamp ?? messageTimestamp(message);
  const model = typeof message.model === "string" ? message.model : undefined;
  if (message.role === "user") {
    const content = blocksText(message.content);
    if (content) {
      events.push({
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
        events.push({
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
        events.push({
          type: "reasoning",
          content: part.thinking,
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      } else if (part.type === "text" && typeof part.text === "string") {
        events.push({
          type: "message",
          role: "assistant",
          content: part.text,
          ...timestamp ? { timestamp } : {},
          ...model ? { model } : {}
        });
      } else if (part.type === "toolCall") {
        events.push({
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
    events.push({
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
    const callIdByActionId = new Map;
    for (const event of parseEvents(transcript)) {
      if (!isObject(event) || typeof event.id !== "string" || !event.id) {
        continue;
      }
      const timestamp = parseTimestamp(event.timestamp);
      if (event.kind === "MessageEvent") {
        if (event.source !== "user" && event.source !== "agent")
          continue;
        const message = isObject(event.llm_message) ? event.llm_message : {};
        const content = joinTextContent(message.content);
        if (!content)
          continue;
        events.push({
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
          events.push({
            type: "reasoning",
            content: thought,
            ...timestamp ? { timestamp } : {}
          });
        }
        const callId2 = typeof event.tool_call_id === "string" && event.tool_call_id ? event.tool_call_id : `oh_${event.id}`;
        callIdByActionId.set(event.id, callId2);
        events.push({
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
      events.push({
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
  for (const message of checkpoint.messages) {
    const timestamp = parseTimestamp(message.timestamp) ?? checkpointTimestamp;
    if (message.role === "human") {
      if (message.content) {
        events.push({
          type: "message",
          role: "user",
          content: message.content,
          ...timestamp ? { timestamp } : {}
        });
      }
      continue;
    }
    if (message.role === "ai") {
      for (const reasoning of message.reasoning) {
        if (!reasoning)
          continue;
        events.push({
          type: "reasoning",
          content: reasoning,
          ...timestamp ? { timestamp } : {},
          ...message.model ? { model: message.model } : {}
        });
      }
      if (message.content) {
        events.push({
          type: "message",
          role: "assistant",
          content: message.content,
          ...timestamp ? { timestamp } : {},
          ...message.model ? { model: message.model } : {}
        });
      }
      for (const call of message.toolCalls) {
        events.push({
          type: "tool_call",
          args: jsonString(call.args),
          ...call.id ? { id: call.id } : {},
          ...call.name ? { name: call.name } : {},
          ...timestamp ? { timestamp } : {},
          ...message.model ? { model: message.model } : {}
        });
      }
      continue;
    }
    events.push({
      type: "tool_result",
      callId: message.toolCallId,
      content: message.content,
      ...timestamp ? { timestamp } : {}
    });
  }
  return {
    events,
    context: {
      source: "deepagents",
      ...checkpoint.cwd ? { cwd: checkpoint.cwd } : {},
      ...checkpoint.model ? { model: checkpoint.model } : {},
      ...checkpointTimestamp ? { createdAt: checkpointTimestamp } : {}
    },
    diagnostics: []
  };
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
function validateTranscript(value) {
  if (!Array.isArray(value) || value.length === 0)
    fail("Transcript must be a non-empty array.");
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
      if (typeof record.tool_call_id !== "string" || !callIds.has(record.tool_call_id)) {
        fail(`Record ${index}: tool result must reference an earlier tool call.`);
      }
      if (typeof record.content !== "string") {
        fail(`Record ${index}: tool content must be a string.`);
      }
      continue;
    }
    fail(`Record ${index}: unknown role ${JSON.stringify(record.role)}.`);
  }
  if (!roles.has("user"))
    fail("Transcript must contain at least one user record.");
  if (!roles.has("assistant"))
    fail("Transcript must contain at least one assistant record.");
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
function normalizeDecodedSession(decoded, bounds) {
  const diagnostics = [...decoded.diagnostics];
  const body = [];
  const anchors = new Map;
  const openCalls = new Map;
  const usedIds = new Set;
  const modelCounts = new Map;
  for (let eventIndex = 0;eventIndex < decoded.events.length; eventIndex += 1) {
    const event = decoded.events[eventIndex];
    if (event === undefined)
      continue;
    if (event.model) {
      modelCounts.set(event.model, (modelCounts.get(event.model) ?? 0) + 1);
    }
    const record = normalizeEvent(event, eventIndex, body.length + 1, openCalls, usedIds, diagnostics, bounds);
    if (!record)
      continue;
    if (event.timestamp && !Number.isNaN(event.timestamp.getTime())) {
      anchors.set(body.length, event.timestamp);
    }
    body.push(record);
  }
  const roles = new Set(body.map((record) => record.role));
  if (!roles.has("user")) {
    throw new NormalizationError("missing_user_records", "Transcript did not contain any normalizable user records.");
  }
  if (!roles.has("assistant")) {
    throw new NormalizationError("missing_assistant_records", "Transcript did not contain any normalizable assistant records.");
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
  validateTranscript(records);
  return { records, diagnostics };
}
function normalizeEvent(event, eventIndex, recordIndex, openCalls, usedIds, diagnostics, bounds) {
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
    const sourceId2 = event.id || `call_${eventIndex + 1}`;
    if (!event.id) {
      diagnostics.push({
        code: "tool_call_id_synthesized",
        message: `Synthesized tool-call ID ${JSON.stringify(sourceId2)}.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    let finalId = sourceId2;
    if (usedIds.has(finalId)) {
      let suffix = 2;
      while (usedIds.has(`${sourceId2}__${suffix}`))
        suffix += 1;
      finalId = `${sourceId2}__${suffix}`;
      diagnostics.push({
        code: "duplicate_tool_call_id",
        message: `Renamed duplicate tool-call ID ${JSON.stringify(sourceId2)} to ${JSON.stringify(finalId)}.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    usedIds.add(finalId);
    const entries2 = openCalls.get(sourceId2) ?? [];
    entries2.push({ finalId, consumed: false });
    openCalls.set(sourceId2, entries2);
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
        message: `Reshaped arguments for tool call ${JSON.stringify(finalId)} into a JSON object.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    if (args.truncated) {
      diagnostics.push({
        code: "tool_arguments_truncated",
        message: `Truncated arguments for tool call ${JSON.stringify(finalId)} to at most ${bounds.toolArguments.maxCharacters} Unicode code points.`,
        recordIndex,
        ...event.inputLine ? { inputLine: event.inputLine } : {}
      });
    }
    const record2 = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: finalId, name, args: args.args }]
    };
    return record2;
  }
  const sourceId = event.callId || "";
  const entries = openCalls.get(sourceId);
  const openEntry = entries?.find((entry) => !entry.consumed);
  if (!openEntry) {
    const duplicate = Boolean(entries && entries.length > 0);
    diagnostics.push({
      code: duplicate ? "duplicate_tool_result" : "orphan_tool_result",
      message: duplicate ? `Dropped a duplicate result for tool call ${JSON.stringify(sourceId)}.` : `Dropped a tool result without a preceding call for ${JSON.stringify(sourceId)}.`,
      recordIndex,
      ...event.inputLine ? { inputLine: event.inputLine } : {}
    });
    return;
  }
  openEntry.consumed = true;
  const resultLimit = bounds.toolResults.maxCharacters;
  const content = resultLimit === null ? event.content : truncateText(event.content, resultLimit, bounds.toolResults.strategy);
  if (content !== event.content) {
    diagnostics.push({
      code: "tool_result_truncated",
      message: `Truncated the result for tool call ${JSON.stringify(openEntry.finalId)} to at most ${resultLimit} Unicode code points using the ${JSON.stringify(bounds.toolResults.strategy)} strategy.`,
      recordIndex,
      ...event.inputLine ? { inputLine: event.inputLine } : {}
    });
  }
  const record = {
    role: "tool",
    tool_call_id: openEntry.finalId,
    content
  };
  return record;
}
function buildMeta(context, modelCounts) {
  let model = context.model;
  if (!model) {
    let highestCount = 0;
    for (const [candidate, count] of modelCounts) {
      if (count > highestCount) {
        model = candidate;
        highestCount = count;
      }
    }
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
      resolve(response.data);
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
  langsmith: langSmithAdapter,
  letta: lettaAdapter,
  openhands: openHandsAdapter
};
function normalizeTranscript(input) {
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
  const bounds = resolveBounds(input.bounds);
  return normalizeDecodedSession(adapter.decode(input.transcript), bounds);
}
async function normalizeCheckpoint(input) {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (input.source !== "deepagents") {
    throw new NormalizationError("unknown_source", `Checkpoint source must be "deepagents"; received ${JSON.stringify(input.source)}.`);
  }
  const checkpoint = await loadDeepAgentsCheckpoint(input.checkpoint);
  return normalizeDecodedSession(decodeDeepAgentsCheckpoint(checkpoint), resolveBounds(input.bounds));
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
