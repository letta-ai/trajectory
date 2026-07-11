import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../internal.js";
import { NormalizationError } from "../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseTimestamp,
} from "./shared.js";

interface OrderedRun {
  run: Record<string, unknown>;
  index: number;
}

interface ConversationItem {
  key: string;
  stable?: boolean;
  event?: DecodedEvent;
}

interface PendingCall {
  id?: string;
  name?: string;
  consumed: boolean;
}

interface AnthropicStreamBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  partialJson: string;
}

interface DecodeState {
  events: DecodedEvent[];
  history: string[];
  pendingCalls: PendingCall[];
}

export const langSmithAdapter: SourceAdapter = {
  source: "langsmith",

  decode(transcript: string): DecodedSession {
    const runs = parseRuns(transcript).sort(compareRuns);
    const state: DecodeState = {
      events: [],
      history: [],
      pendingCalls: [],
    };
    let model: string | undefined;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let createdAt: Date | undefined;

    for (const { run } of runs) {
      const metadata = runMetadata(run);
      model ??= firstString(metadata.ls_model_name, metadata.model);
      cwd ??= firstString(metadata.cwd, metadata.working_directory);
      gitBranch ??= firstString(metadata.git_branch, metadata.gitBranch);
      const start = parseTimestamp(run.start_time);
      const end = parseTimestamp(run.end_time) ?? start;
      createdAt ??= start;

      if (run.run_type === "llm") {
        const runModel = firstString(
          metadata.ls_model_name,
          metadata.model,
          model,
        );
        mergeItems(
          state,
          decodeMessages(inputMessages(run.inputs), start, runModel),
        );
        mergeItems(
          state,
          decodeMessages(outputMessages(run.outputs), end, runModel, "assistant"),
        );
        continue;
      }

      if (run.run_type === "tool") {
        const result = decodeToolRun(run, end, state.pendingCalls);
        if (result) mergeItems(state, [result]);
      }
    }

    return {
      events: state.events,
      context: {
        source: "langsmith",
        ...(cwd ? { cwd } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(model ? { model } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      diagnostics: [],
    };
  },
};

function parseRuns(transcript: string): OrderedRun[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidTranscript();
  }

  const runs = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.runs)
      ? parsed.runs
      : undefined;
  if (!runs || runs.length === 0 || !runs.every(isCanonicalRun)) {
    throw invalidTranscript();
  }
  return runs.map((run, index) => ({ run, index }));
}

function isCanonicalRun(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.trace_id === "string" &&
    typeof value.name === "string" &&
    typeof value.run_type === "string" &&
    isObject(value.inputs)
  );
}

function invalidTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "LangSmith transcript must be a non-empty JSON array of canonical Run records or an object with a runs array.",
  );
}

function compareRuns(left: OrderedRun, right: OrderedRun): number {
  const leftOrder = left.run.dotted_order;
  const rightOrder = right.run.dotted_order;
  if (typeof leftOrder === "string" && typeof rightOrder === "string") {
    const order = leftOrder.localeCompare(rightOrder);
    if (order !== 0) return order;
  }
  const leftTime = parseTimestamp(left.run.start_time)?.getTime();
  const rightTime = parseTimestamp(right.run.start_time)?.getTime();
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.index - right.index;
}

function runMetadata(run: Record<string, unknown>): Record<string, unknown> {
  const extra = isObject(run.extra) ? run.extra : {};
  return isObject(extra.metadata) ? extra.metadata : {};
}

function inputMessages(value: unknown): unknown[] {
  if (!isObject(value)) return [];
  const messages: unknown[] = [];
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
      if (typeof prompt === "string") messages.push({ role: "user", content: prompt });
    }
  }
  return messages;
}

function outputMessages(value: unknown): unknown[] {
  if (!isObject(value)) {
    if (typeof value !== "string") return [];
    const streamed = anthropicStreamMessages(value);
    return streamed.length > 0
      ? streamed
      : [{ role: "assistant", content: value }];
  }

  if (Array.isArray(value.generations)) {
    const firstBatch = Array.isArray(value.generations[0])
      ? value.generations[0]
      : value.generations;
    const messages: unknown[] = [];
    for (const generation of firstBatch) {
      if (!isObject(generation)) continue;
      if (generation.message !== undefined) messages.push(generation.message);
      else if (typeof generation.text === "string") {
        messages.push({ role: "assistant", content: generation.text });
      }
    }
    if (messages.length > 0) return messages;
  }

  if (Array.isArray(value.choices)) {
    const messages = value.choices
      .map((choice) => (isObject(choice) ? choice.message : undefined))
      .filter((message) => message !== undefined);
    if (messages.length > 0) return messages;
  }

  if (Array.isArray(value.messages)) return value.messages;
  if (isObject(value.message)) return [value.message];
  if (Array.isArray(value.output)) return value.output;
  if (typeof value.output === "string") {
    const streamed = anthropicStreamMessages(value.output);
    return streamed.length > 0
      ? streamed
      : [{ role: "assistant", content: value.output }];
  }
  if (isObject(value.output)) {
    if (Array.isArray(value.output.messages)) return value.output.messages;
    if (isObject(value.output.update) && Array.isArray(value.output.update.messages)) {
      return value.output.update.messages;
    }
  }
  if (value.role !== undefined || value.type === "message") return [value];
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return [{ role: "assistant", content: value.content }];
  }
  return [];
}

function anthropicStreamMessages(output: string): unknown[] {
  // LangSmith's wrapAnthropic performs equivalent aggregation before ingest,
  // but its messageAggregator is private. This handles traces produced by
  // custom HTTP instrumentation that stored the raw Anthropic SSE response.
  if (!output.includes("event:") || !output.includes("\ndata:")) return [];
  const blocks = new Map<number, AnthropicStreamBlock>();

  for (const line of output.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (!raw || raw === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(event) || typeof event.index !== "number") continue;

    if (event.type === "content_block_start" && isObject(event.content_block)) {
      const content = event.content_block;
      if (typeof content.type !== "string") continue;
      blocks.set(event.index, {
        type: content.type,
        ...(typeof content.text === "string" ? { text: content.text } : {}),
        ...(typeof content.thinking === "string"
          ? { thinking: content.thinking }
          : {}),
        ...(typeof content.id === "string" ? { id: content.id } : {}),
        ...(typeof content.name === "string" ? { name: content.name } : {}),
        ...(content.input !== undefined ? { input: content.input } : {}),
        partialJson: "",
      });
      continue;
    }

    if (event.type !== "content_block_delta" || !isObject(event.delta)) {
      continue;
    }
    const delta = event.delta;
    const block = blocks.get(event.index);
    if (!block) continue;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      block.text = (block.text ?? "") + delta.text;
    } else if (
      delta.type === "thinking_delta" &&
      typeof delta.thinking === "string"
    ) {
      block.thinking = (block.thinking ?? "") + delta.thinking;
    } else if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string"
    ) {
      block.partialJson += delta.partial_json;
    }
  }

  const content: Record<string, unknown>[] = [];
  for (const [, block] of [...blocks].sort(([left], [right]) => left - right)) {
    if (block.type === "text" && block.text) {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && block.thinking) {
      content.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_use",
        ...(block.id ? { id: block.id } : {}),
        ...(block.name ? { name: block.name } : {}),
        input: streamedToolInput(block),
      });
    }
  }
  return content.length > 0 ? [{ role: "assistant", content }] : [];
}

function streamedToolInput(block: AnthropicStreamBlock): unknown {
  if (!block.partialJson) return block.input ?? {};
  try {
    return JSON.parse(block.partialJson);
  } catch {
    return { _raw: block.partialJson };
  }
}

function messageArray(value: unknown, fallbackRole: string): unknown[] {
  if (typeof value === "string") return [{ role: fallbackRole, content: value }];
  if (isObject(value)) return [value];
  if (!Array.isArray(value)) return [];
  if (value.length === 1 && Array.isArray(value[0])) return value[0];
  return value;
}

function decodeMessages(
  messages: unknown[],
  timestamp?: Date,
  model?: string,
  fallbackRole?: string,
): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const message of messages) {
    items.push(...decodeMessage(message, timestamp, model, fallbackRole));
  }
  return items;
}

function decodeMessage(
  value: unknown,
  timestamp?: Date,
  model?: string,
  fallbackRole?: string,
): ConversationItem[] {
  if (typeof value === "string") {
    return [messageItem(fallbackRole ?? "assistant", value, undefined, 0, timestamp, model)];
  }
  if (!isObject(value)) return [];

  const constructorClass = constructorName(value);
  const body = isObject(value.kwargs) ? value.kwargs : value;
  const stableId = firstString(body.id, value.id);
  const role = canonicalRole(
    firstString(body.role, body.type, fallbackRole),
    constructorClass,
  );
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

  const items: ConversationItem[] = [];
  const content = body.content;
  if (Array.isArray(content)) {
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (typeof block === "string") {
        items.push(messageItem(role, block, stableId, index, timestamp, model));
      } else if (isObject(block)) {
        items.push(...decodeContentBlock(block, role, stableId, index, timestamp, model));
      }
    }
  } else {
    const text = contentText(content);
    if (text) items.push(messageItem(role, text, stableId, 0, timestamp, model));
  }

  if (role === "assistant" && Array.isArray(body.tool_calls)) {
    for (let index = 0; index < body.tool_calls.length; index += 1) {
      const call = body.tool_calls[index];
      if (isObject(call)) {
        items.push(toolCallItem(call, stableId, index + items.length, timestamp, model));
      }
    }
  }
  return items;
}

function decodeContentBlock(
  block: Record<string, unknown>,
  role: string,
  stableId: string | undefined,
  index: number,
  timestamp?: Date,
  model?: string,
): ConversationItem[] {
  const type = block.type;
  if (type === "tool_use" || type === "tool-call" || type === "function_call") {
    return [toolCallItem(block, stableId, index, timestamp, model)];
  }
  if (
    type === "tool_result" ||
    type === "tool-result" ||
    type === "function_call_output"
  ) {
    return [toolResultItem(block, stableId, index, timestamp)];
  }
  if (type === "thinking" || type === "reasoning" || type === "redacted_thinking") {
    const text = reasoningText(block);
    return text ? [reasoningItem(text, stableId, index, timestamp, model)] : [];
  }
  if (type === "image" || type === "image_url") {
    return [messageItem(role, "[image]", stableId, index, timestamp, model)];
  }
  const text = contentText(block.text ?? block.content);
  return text ? [messageItem(role, text, stableId, index, timestamp, model)] : [];
}

function messageItem(
  role: string,
  content: string,
  stableId: string | undefined,
  index: number,
  timestamp?: Date,
  model?: string,
): ConversationItem {
  const canonical = role === "assistant" ? "assistant" : role === "user" ? "user" : role;
  const key = stableId
    ? `message:${stableId}:${index}`
    : `message:${canonical}:${jsonString(content)}`;
  if (canonical !== "user" && canonical !== "assistant") return { key };
  return {
    key,
    ...(stableId ? { stable: true } : {}),
    event: {
      type: "message",
      role: canonical,
      content,
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
    },
  };
}

function reasoningItem(
  content: string,
  stableId: string | undefined,
  index: number,
  timestamp?: Date,
  model?: string,
): ConversationItem {
  return {
    key: stableId
      ? `reasoning:${stableId}:${index}`
      : `reasoning:${jsonString(content)}`,
    ...(stableId ? { stable: true } : {}),
    event: {
      type: "reasoning",
      content,
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
    },
  };
}

function toolCallItem(
  value: Record<string, unknown>,
  stableId: string | undefined,
  index: number,
  timestamp?: Date,
  model?: string,
): ConversationItem {
  const fn = isObject(value.function) ? value.function : {};
  const id = firstString(value.id, value.call_id, value.toolCallId);
  const name = firstString(value.name, value.toolName, fn.name);
  const rawArgs = firstDefined(value.arguments, value.args, value.input, fn.arguments);
  const args = typeof rawArgs === "string" ? rawArgs : jsonString(rawArgs);
  return {
    key: id
      ? `tool-call:${id}`
      : `tool-call:${stableId ?? ""}:${index}:${name ?? ""}:${args}`,
    ...(id || stableId ? { stable: true } : {}),
    event: {
      type: "tool_call",
      args,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
    },
  };
}

function toolResultItem(
  value: Record<string, unknown>,
  stableId: string | undefined,
  index: number,
  timestamp?: Date,
): ConversationItem {
  const id = firstString(
    value.tool_call_id,
    value.tool_use_id,
    value.call_id,
    value.toolCallId,
  );
  const raw = firstDefined(value.output, value.result, value.content);
  const content = resultText(raw);
  return {
    key: id
      ? `tool-result:${id}`
      : `tool-result:${stableId ?? ""}:${index}:${content}`,
    ...(id || stableId ? { stable: true } : {}),
    event: {
      type: "tool_result",
      content,
      ...(id ? { callId: id } : {}),
      ...(timestamp ? { timestamp } : {}),
    },
  };
}

function decodeToolRun(
  run: Record<string, unknown>,
  timestamp: Date | undefined,
  pendingCalls: PendingCall[],
): ConversationItem | undefined {
  const inputs = isObject(run.inputs) ? run.inputs : {};
  const outputs = isObject(run.outputs) ? run.outputs : {};
  const embedded = embeddedToolMessage(outputs);
  const explicitId = firstString(
    inputs.toolCallId,
    inputs.tool_call_id,
    inputs.call_id,
    outputs.toolCallId,
    outputs.tool_call_id,
    outputs.call_id,
    embedded?.tool_call_id,
    embedded?.tool_use_id,
    embedded?.call_id,
  );
  const name = firstString(inputs.toolName, inputs.tool_name, run.name);
  const call = matchPendingCall(pendingCalls, explicitId, name);
  const callId = explicitId ?? call?.id;
  const rawResult = firstDefined(
    embedded?.content,
    embedded?.output,
    embedded?.result,
    outputs.result,
    outputs.output,
    outputs.content,
    run.error,
  );
  if (rawResult === undefined) return undefined;
  let content = resultText(rawResult);
  if (run.error && rawResult === run.error && !/^error/i.test(content)) {
    content = `Error: ${content}`;
  }
  return {
    key: callId
      ? `tool-result:${callId}`
      : `tool-run:${firstString(run.id) ?? "unknown"}`,
    stable: true,
    event: {
      type: "tool_result",
      content,
      ...(callId ? { callId } : {}),
      ...(timestamp ? { timestamp } : {}),
    },
  };
}

function embeddedToolMessage(
  outputs: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const output = isObject(outputs.output) ? outputs.output : undefined;
  const candidate = output ?? (isObject(outputs.message) ? outputs.message : undefined);
  if (!candidate) return undefined;
  return isObject(candidate.kwargs) ? candidate.kwargs : candidate;
}

function matchPendingCall(
  pendingCalls: PendingCall[],
  id: string | undefined,
  name: string | undefined,
): PendingCall | undefined {
  let match = id
    ? pendingCalls.find((call) => !call.consumed && call.id === id)
    : undefined;
  match ??= name
    ? pendingCalls.find((call) => !call.consumed && call.name === name)
    : undefined;
  const remaining = pendingCalls.filter((call) => !call.consumed);
  match ??= remaining.length === 1 ? remaining[0] : undefined;
  if (match) match.consumed = true;
  return match;
}

function mergeItems(state: DecodeState, items: ConversationItem[]): void {
  if (items.length === 0) return;
  let overlap = Math.min(state.history.length, items.length);
  while (overlap > 0) {
    let matches = true;
    const historyStart = state.history.length - overlap;
    for (let index = 0; index < overlap; index += 1) {
      if (state.history[historyStart + index] !== items[index]?.key) {
        matches = false;
        break;
      }
    }
    if (matches) break;
    overlap -= 1;
  }

  const repeatedSnapshot =
    overlap === 0 &&
    items.some((item) => item.stable === true && state.history.includes(item.key));

  for (let index = overlap; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (item.stable === true && state.history.includes(item.key)) continue;
    if (repeatedSnapshot && state.history.includes(item.key)) continue;
    state.history.push(item.key);
    if (!item.event) continue;
    if (isDuplicateAdjacentMessage(state.events.at(-1), item.event)) continue;
    state.events.push(item.event);
    if (item.event.type === "tool_call") {
      state.pendingCalls.push({
        ...(item.event.id ? { id: item.event.id } : {}),
        ...(item.event.name ? { name: item.event.name } : {}),
        consumed: false,
      });
    } else if (item.event.type === "tool_result" && item.event.callId) {
      matchPendingCall(state.pendingCalls, item.event.callId, undefined);
    }
  }
}

function isDuplicateAdjacentMessage(
  previous: DecodedEvent | undefined,
  current: DecodedEvent,
): boolean {
  return (
    previous?.type === "message" &&
    current.type === "message" &&
    previous.role === current.role &&
    previous.content === current.content &&
    previous.timestamp?.getTime() === current.timestamp?.getTime()
  );
}

function canonicalRole(value: string | undefined, constructorClass?: string): string {
  if (constructorClass === "HumanMessage" || constructorClass === "ChatMessage") {
    return "user";
  }
  if (constructorClass === "AIMessage") return "assistant";
  if (constructorClass === "ToolMessage" || constructorClass === "FunctionMessage") {
    return "tool";
  }
  if (constructorClass === "SystemMessage") return "system";
  if (value === "human") return "user";
  if (value === "ai") return "assistant";
  if (value === "function") return "tool";
  return value ?? "assistant";
}

function constructorName(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.id)) return undefined;
  const last = value.id[value.id.length - 1];
  return typeof last === "string" ? last : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return blocksText(value);
  if (isObject(value) && typeof value.value === "string") return value.value;
  return "";
}

function reasoningText(value: Record<string, unknown>): string {
  const direct = firstString(value.thinking, value.text, value.content);
  if (direct) return direct;
  if (Array.isArray(value.summary)) {
    return value.summary
      .map((item) => (isObject(item) ? contentText(item.text ?? item.content) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return blocksText(value) || jsonString(value);
  if (isObject(value)) {
    if (isObject(value.kwargs)) return resultText(value.kwargs.content);
    if (typeof value.content === "string") return value.content;
  }
  return jsonString(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstNonEmpty(...values: unknown[]): unknown {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.length > 0),
  );
}
