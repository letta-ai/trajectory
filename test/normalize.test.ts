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
  { source: "claude-code", name: "claude-code/tool-call", input: "input.jsonl" },
  { source: "claude-code", name: "claude-code/cleanup", input: "input.jsonl" },
  { source: "codex", name: "codex/tool-calls", input: "input.jsonl" },
  { source: "codex", name: "codex/cleanup", input: "input.jsonl" },
  { source: "deepagents-code", name: "deepagents-code/tool-calls", input: "input.json" },
  { source: "deepagents-code", name: "deepagents-code/cleanup", input: "input.json" },
  { source: "letta", name: "letta/tool-call", input: "input.json" },
  { source: "letta", name: "letta/cleanup", input: "input.json" },
  { source: "letta", name: "letta/local-v3", input: "input.jsonl" },
  { source: "letta", name: "letta/local-legacy", input: "input.jsonl" },
  { source: "openhands", name: "openhands/tool-calls", input: "input.json" },
  { source: "openhands", name: "openhands/cleanup", input: "input.json" },
] as const satisfies ReadonlyArray<{
  source: TrajectorySource;
  name: string;
  input: string;
}>;

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
      const input = fixtureText(fixture.name, fixture.input);
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
        source: "langsmith" as TrajectorySource,
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

  test("rejects an invalid Deep Agents Code envelope", () => {
    expect(() =>
      normalizeTranscript({
        source: "deepagents-code",
        transcript: JSON.stringify({
          type: "deepagents-code-thread",
          version: 2,
          thread_id: "thread-1",
          checkpoint_ns: "",
          messages: [],
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("rejects unsafe non-dictionary Deep Agents Code messages", () => {
    expect(() =>
      normalizeTranscript({
        source: "deepagents-code",
        transcript: JSON.stringify({
          type: "deepagents-code-thread",
          version: 1,
          thread_id: "thread-1",
          checkpoint_ns: "",
          messages: [{ message: "not decoded" }],
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("rejects a non-flat Letta document shape", () => {
    expect(() =>
      normalizeTranscript({
        source: "letta",
        transcript: '[[{"message_type":"user_message"}]]',
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("rejects an unsupported Letta local transcript version", () => {
    expect(() =>
      normalizeTranscript({
        source: "letta",
        transcript: '{"type":"session","version":4}',
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
