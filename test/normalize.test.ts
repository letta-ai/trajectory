import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NORMALIZATION_BOUNDS,
  normalizeTranscript,
  validateTranscript,
} from "../src/index.js";
import type { NormalizeResult, TrajectorySource } from "../src/index.js";

const fixtures = [
  { source: "claude-code", name: "claude-code/tool-call" },
  { source: "claude-code", name: "claude-code/cleanup" },
  { source: "codex", name: "codex/tool-calls" },
  { source: "codex", name: "codex/cleanup" },
  { source: "langsmith", name: "langsmith/tool-call" },
  { source: "langsmith", name: "langsmith/cleanup" },
  { source: "letta", name: "letta/tool-call" },
  { source: "letta", name: "letta/cleanup" },
  { source: "openhands", name: "openhands/tool-calls" },
  { source: "openhands", name: "openhands/cleanup" },
] as const satisfies ReadonlyArray<{ source: TrajectorySource; name: string }>;

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/trajectory-v1.schema.json", import.meta.url)),
    "utf8",
  ),
) as object;
const validateSchema = new Ajv2020().compile(schema);

describe("golden fixtures", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const input = fixtureText(
        fixture.name,
        fixture.source === "openhands" || fixture.source === "letta"
          ? "input.json"
          : "input.jsonl",
      );
      const expected = JSON.parse(
        fixtureText(fixture.name, "expected.json"),
      ) as NormalizeResult;

      const result = normalizeTranscript({ source: fixture.source, transcript: input });
      const schemaValid = validateSchema(result.records) as boolean;

      expect(result).toEqual(expected);
      expect(schemaValid).toBe(true);
      expect(() => validateTranscript(result.records)).not.toThrow();
    });
  }
});

describe("public API", () => {
  test("always returns diagnostics", () => {
    const result = normalizeTranscript({
      source: "codex",
      transcript: codexMessages("hello", "hi"),
    });

    expect(Array.isArray(result.records)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  test("rejects an unknown source", () => {
    expect(() =>
      normalizeTranscript({
        source: "not-a-source" as TrajectorySource,
        transcript: "{}",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "unknown_source",
      }),
    );
  });

  test("rejects a transcript without a user turn", () => {
    const transcript = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      },
    });

    expect(() => normalizeTranscript({ source: "codex", transcript })).toThrow(
      expect.objectContaining({
        code: "missing_user_records",
      }),
    );
  });

  test("rejects an invalid OpenHands document shape", () => {
    expect(() =>
      normalizeTranscript({
        source: "openhands",
        transcript: "{}",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("rejects an invalid LangSmith document shape", () => {
    expect(() =>
      normalizeTranscript({
        source: "langsmith",
        transcript: '{"runs":{}}',
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("accepts a single LangSmith run object", () => {
    const transcript = JSON.stringify({
      id: "run-1",
      run_type: "llm",
      start_time: "2026-07-10T00:00:00Z",
      end_time: "2026-07-10T00:00:01Z",
      inputs: { messages: [{ role: "user", content: "hello" }] },
      outputs: {
        choices: [{ message: { role: "assistant", content: "hi" } }],
      },
    });

    const result = normalizeTranscript({ source: "langsmith", transcript });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
  });

  test("flattens nested LangSmith runs envelopes", () => {
    const transcript = JSON.stringify({
      runs: [
        {
          id: "root",
          run_type: "chain",
          child_runs: [
            {
              id: "llm",
              run_type: "llm",
              inputs: { messages: [{ role: "user", content: "hello" }] },
              outputs: { role: "assistant", content: "hi" },
            },
          ],
        },
      ],
    });

    const result = normalizeTranscript({ source: "langsmith", transcript });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
  });

  test("decodes Anthropic reasoning and tool blocks from LangSmith runs", () => {
    const firstAssistant = {
      id: "msg-1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should check." },
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          id: "toolu-1",
          name: "weather",
          input: { city: "Paris" },
        },
      ],
    };
    const transcript = JSON.stringify([
      {
        id: "llm-1",
        run_type: "llm",
        start_time: "2026-07-10T00:00:00Z",
        end_time: "2026-07-10T00:00:01Z",
        inputs: { messages: [{ role: "user", content: "weather?" }] },
        outputs: { message: firstAssistant },
      },
      {
        id: "tool-1",
        run_type: "tool",
        name: "weather",
        start_time: "2026-07-10T00:00:02Z",
        end_time: "2026-07-10T00:00:03Z",
        inputs: { city: "Paris" },
        outputs: { output: { condition: "sunny" } },
      },
      {
        id: "llm-2",
        run_type: "llm",
        start_time: "2026-07-10T00:00:04Z",
        end_time: "2026-07-10T00:00:05Z",
        inputs: {
          messages: [
            { role: "user", content: "weather?" },
            firstAssistant,
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu-1", content: "sunny" },
              ],
            },
          ],
        },
        outputs: { message: { role: "assistant", content: "It is sunny." } },
      },
    ]);

    const result = normalizeTranscript({ source: "langsmith", transcript });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "reasoning",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.records.filter((record) => record.role === "tool")).toHaveLength(1);
  });

  test("decodes OpenAI Responses items from LangSmith runs", () => {
    const transcript = JSON.stringify([
      {
        id: "response-1",
        run_type: "llm",
        start_time: "2026-07-10T00:00:00Z",
        end_time: "2026-07-10T00:00:01Z",
        inputs: {
          instructions: "Be helpful.",
          input: [{ type: "message", role: "user", content: "weather?" }],
        },
        outputs: {
          output: [
            {
              type: "reasoning",
              id: "reasoning-1",
              summary: [{ type: "summary_text", text: "Check weather." }],
            },
            {
              type: "function_call",
              call_id: "call-1",
              name: "weather",
              arguments: '{"city":"Paris"}',
            },
          ],
        },
      },
      {
        id: "tool-1",
        run_type: "tool",
        name: "weather",
        start_time: "2026-07-10T00:00:02Z",
        end_time: "2026-07-10T00:00:03Z",
        inputs: { call_id: "call-1" },
        outputs: { output: "sunny" },
      },
      {
        id: "response-2",
        run_type: "llm",
        start_time: "2026-07-10T00:00:04Z",
        end_time: "2026-07-10T00:00:05Z",
        inputs: {
          input: [
            { type: "message", role: "user", content: "weather?" },
            {
              type: "function_call",
              call_id: "call-1",
              name: "weather",
              arguments: '{"city":"Paris"}',
            },
            { type: "function_call_output", call_id: "call-1", output: "sunny" },
          ],
        },
        outputs: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "It is sunny." }],
            },
          ],
        },
      },
    ]);

    const result = normalizeTranscript({ source: "langsmith", transcript });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "reasoning",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("rejects a non-flat Letta document shape", () => {
    expect(() =>
      normalizeTranscript({
        source: "letta",
        transcript: '[[{"message_type":"user_message"}]]',
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("reports tool-result truncation", () => {
    const transcript = codexToolTranscript(
      `BEGIN:${"x".repeat(3_000)}:END`,
    );

    const result = normalizeTranscript({ source: "codex", transcript });
    const tool = result.records.find((record) => record.role === "tool");

    expect(Array.from(tool?.content ?? "")).toHaveLength(2_500);
    expect(tool?.content).toStartWith("BEGIN:");
    expect(tool?.content).toEndWith(":END");
    expect(tool?.content).toMatch(/\[truncated, \d+ more chars\]/);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "tool_result_truncated",
    );
  });

  test("supports head-only tool-result truncation", () => {
    const result = normalizeTranscript({
      source: "codex",
      transcript: codexToolTranscript(`BEGIN:${"x".repeat(200)}:END`),
      bounds: {
        toolResults: { maxCharacters: 80, strategy: "head" },
      },
    });
    const tool = result.records.find((record) => record.role === "tool");

    expect(Array.from(tool?.content ?? "")).toHaveLength(80);
    expect(tool?.content).toStartWith("BEGIN:");
    expect(tool?.content).not.toEndWith(":END");
  });

  test("counts bounds in Unicode code points", () => {
    const result = normalizeTranscript({
      source: "codex",
      transcript: codexToolTranscript(`BEGIN:${"😀".repeat(100)}:END`),
      bounds: {
        toolResults: { maxCharacters: 50 },
      },
    });
    const tool = result.records.find((record) => record.role === "tool");

    expect(Array.from(tool?.content ?? "")).toHaveLength(50);
    expect(tool?.content).toStartWith("BEGIN:");
    expect(tool?.content).toEndWith(":END");
    expect(tool?.content).not.toContain("�");
  });

  test("allows individual bounds to be disabled", () => {
    const output = "x".repeat(3_000);
    const result = normalizeTranscript({
      source: "codex",
      transcript: codexToolTranscript(output),
      bounds: {
        toolResults: { maxCharacters: null },
      },
    });
    const tool = result.records.find((record) => record.role === "tool");

    expect(tool?.content).toBe(output);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "tool_result_truncated",
    );
  });

  test("applies a custom tool-argument bound", () => {
    const transcript = [
      codexMessage("user", "process the content"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "large_tool",
          call_id: "call_custom_bound",
          arguments: JSON.stringify({ content: "😀".repeat(1_000) }),
        },
      }),
    ].join("\n");

    const result = normalizeTranscript({
      source: "codex",
      transcript,
      bounds: { toolArguments: { maxCharacters: 500 } },
    });
    const assistant = result.records.find(
      (record) => record.role === "assistant" && record.content === null,
    );
    const args = assistant?.tool_calls[0]?.args ?? "";

    expect(Array.from(args).length).toBeLessThanOrEqual(500);
    expect(JSON.parse(args)).toBeObject();
  });

  test("publishes immutable defaults", () => {
    expect(DEFAULT_NORMALIZATION_BOUNDS).toEqual({
      toolArguments: { maxCharacters: 20_000 },
      toolResults: { maxCharacters: 2_500, strategy: "head-tail" },
    });
    expect(Object.isFrozen(DEFAULT_NORMALIZATION_BOUNDS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_NORMALIZATION_BOUNDS.toolResults)).toBe(true);
  });

  test("rejects invalid bounds", () => {
    expect(() =>
      normalizeTranscript({
        source: "codex",
        transcript: codexMessages("hello", "hi"),
        bounds: { toolResults: { maxCharacters: 0 } },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));

    expect(() =>
      normalizeTranscript({
        source: "codex",
        transcript: codexMessages("hello", "hi"),
        bounds: {
          toolResults: { strategy: "middle" },
        } as never,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("terminates when many argument strings cannot fit at the preferred floor", () => {
    const argumentsObject = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, "x".repeat(2_500)]),
    );
    const transcript = [
      codexMessage("user", "process the fields"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "large_tool",
          call_id: "call_large",
          arguments: JSON.stringify(argumentsObject),
        },
      }),
    ].join("\n");

    const result = normalizeTranscript({ source: "codex", transcript });
    const assistant = result.records.find(
      (record) => record.role === "assistant" && record.content === null,
    );
    const args = assistant?.tool_calls[0]?.args;

    expect(args?.length).toBeLessThanOrEqual(20_000);
    expect(JSON.parse(args ?? "null")).toBeObject();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "tool_arguments_truncated",
    );
  });

  test("enforces the cap when many individually small argument strings overflow it", () => {
    const argumentsObject = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`field_${index}`, "x".repeat(1_000)]),
    );
    const transcript = [
      codexMessage("user", "process the fields"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "large_tool",
          call_id: "call_many_small",
          arguments: JSON.stringify(argumentsObject),
        },
      }),
    ].join("\n");

    const result = normalizeTranscript({ source: "codex", transcript });
    const assistant = result.records.find(
      (record) => record.role === "assistant" && record.content === null,
    );
    const args = assistant?.tool_calls[0]?.args;

    expect(args?.length).toBeLessThanOrEqual(20_000);
    expect(JSON.parse(args ?? "null")).toBeObject();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "tool_arguments_truncated",
    );
  });

  test("preserves legacy truncation output when the legacy algorithm fits", () => {
    const original = "x".repeat(40_000);
    const firstKeep = 20_000;
    const first =
      original.slice(0, firstKeep) +
      `\n… [truncated, ${original.length - firstKeep} more chars]`;
    const secondKeep = Math.floor(first.length / 2);
    const expectedValue =
      first.slice(0, secondKeep) +
      `\n… [truncated, ${first.length - secondKeep} more chars]`;
    const transcript = [
      codexMessage("user", "process the content"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "large_tool",
          call_id: "call_legacy",
          arguments: JSON.stringify({ content: original }),
        },
      }),
    ].join("\n");

    const result = normalizeTranscript({ source: "codex", transcript });
    const assistant = result.records.find(
      (record) => record.role === "assistant" && record.content === null,
    );

    expect(assistant?.tool_calls[0]?.args).toBe(
      JSON.stringify({ content: expectedValue }),
    );
  });

  test("interpolates missing timestamps and reports the repair", () => {
    const transcript = [
      JSON.stringify({
        timestamp: "2026-07-01T12:00:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
      codexMessage("assistant", "hi"),
    ].join("\n");

    const result = normalizeTranscript({ source: "codex", transcript });
    const assistant = result.records.find((record) => record.role === "assistant");

    expect(assistant?.timestamp).toBe("2026-07-01T12:00:01.000Z");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "timestamps_interpolated", count: 1 }),
    );
  });
});

describe("validation", () => {
  test("rejects tool arguments that do not encode an object", () => {
    const invalid = [
      { role: "meta", source: "codex" },
      {
        role: "user",
        content: "hello",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", name: "tool", args: "[]" }],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];

    expect(() => validateTranscript(invalid)).toThrow(
      "tool-call args must encode a JSON object",
    );
  });
});

function fixtureText(name: string, file: string): string {
  const url = new URL(`../fixtures/${name}/${file}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function codexMessages(user: string, assistant: string): string {
  return [codexMessage("user", user), codexMessage("assistant", assistant)].join("\n");
}

function codexMessage(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "user" ? "input_text" : "output_text",
          text,
        },
      ],
    },
  });
}

function codexToolTranscript(output: string): string {
  return [
    codexMessage("user", "run the command"),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: "{}",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output,
      },
    }),
  ].join("\n");
}
