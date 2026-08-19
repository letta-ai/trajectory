import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadDeepAgentsCheckpoint,
  normalizeCheckpoint,
  normalizeCheckpointToCanonical,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "fixtures/deepagents/checkpoint.db");
const PYTHON = findLangGraphPython();
const integrationTest = PYTHON ? test : test.skip;
let temporaryDirectory = "";
let databasePath = "";

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "trajectory-deepagents-"));
  databasePath = join(temporaryDirectory, "checkpoint.db");
  copyFileSync(FIXTURE, databasePath);
});

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("Deep Agents Python checkpoints", () => {
  integrationTest("loads latest state with delta history and pending writes", async () => {
    const checkpoint = await loadDeepAgentsCheckpoint({
      path: databasePath,
      threadId: "thread-123",
      pythonExecutable: PYTHON!,
    });

    expect(checkpoint.checkpointId).toBe(
      "00000000-0000-6000-8000-000000000002",
    );
    expect(checkpoint.cwd).toBe("/workspace/deep-agent");
    expect(checkpoint.model).toBe("anthropic:claude-sonnet-4-6");
    expect(checkpoint.messages.map((message) => message.role)).toEqual([
      "human",
      "ai",
      "tool",
      "ai",
    ]);
    expect(checkpoint.messages[2]).toEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-weather-1",
        content: "Sunny, 22 C",
      }),
    );
  });

  integrationTest("normalizes canonical messages, reasoning, calls, and results", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-123",
        pythonExecutable: PYTHON!,
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.records).toEqual([
      {
        role: "meta",
        source: "deepagents",
        cwd: "/workspace/deep-agent",
        model: "anthropic:claude-sonnet-4-6",
      },
      {
        role: "user",
        content: "What is the weather in Paris?",
        timestamp: "2026-01-02T03:04:05.000Z",
      },
      {
        role: "reasoning",
        content: "I should call the weather tool.",
        timestamp: "2026-01-02T03:04:06.000Z",
      },
      {
        role: "assistant",
        content: "I will check the weather.",
        timestamp: "2026-01-02T03:04:06.000Z",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-weather-1",
            name: "weather",
            args: '{"city":"Paris"}',
          },
        ],
        timestamp: "2026-01-02T03:04:06.000Z",
      },
      {
        role: "tool",
        tool_call_id: "call-weather-1",
        content: "Sunny, 22 C",
        timestamp: "2026-01-02T03:04:07.000Z",
      },
      {
        role: "assistant",
        content: "It is sunny and 22 C in Paris.",
        timestamp: "2026-01-02T03:04:08.000Z",
      },
    ]);
  });

  integrationTest("omits tool results while retaining calls", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-123",
        pythonExecutable: PYTHON!,
      },
      filters: { toolResults: "omit" },
    });
    expect(result.records.some((record) => record.role === "tool")).toBe(false);
    expect(
      result.records.some(
        (record) => record.role === "assistant" && record.content === null,
      ),
    ).toBe(true);
  });

  integrationTest("keeps threads in one store separate", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-basic",
        pythonExecutable: PYTHON!,
      },
    });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
    expect(result.records[1]).toEqual(
      expect.objectContaining({ content: "Basic thread" }),
    );
  });

  integrationTest("applies LangGraph Overwrite message semantics", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-overwrite",
        pythonExecutable: PYTHON!,
      },
    });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
    expect(result.records[1]).toEqual(
      expect.objectContaining({ content: "Replacement user" }),
    );
    expect(result.records[2]).toEqual(
      expect.objectContaining({ content: "Replacement response" }),
    );
  });

  integrationTest("reports a missing checkpoint", async () => {
    await expect(
      loadDeepAgentsCheckpoint({
        path: databasePath,
        threadId: "missing-thread",
        pythonExecutable: PYTHON!,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "checkpoint_not_found" }));
  });

  test("requires threadId before starting Python", async () => {
    await expect(
      loadDeepAgentsCheckpoint({
        path: databasePath,
        threadId: "",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });

  test("reports an unavailable Python interpreter", async () => {
    await expect(
      loadDeepAgentsCheckpoint({
        path: databasePath,
        threadId: "thread-123",
        pythonExecutable: join(temporaryDirectory, "missing-python"),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "python_unavailable" }));
  });

  test("surfaces a missing LangGraph dependency", async () => {
    const fakePython = join(temporaryDirectory, "python-without-langgraph");
    writeFileSync(
      fakePython,
      '#!/bin/sh\nprintf \'%s\' \'{"ok":false,"code":"python_dependency_missing","message":"install LangGraph"}\'\n',
    );
    chmodSync(fakePython, 0o755);

    await expect(
      loadDeepAgentsCheckpoint({
        path: databasePath,
        threadId: "thread-123",
        pythonExecutable: fakePython,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "python_dependency_missing",
        message: "install LangGraph",
      }),
    );
  });

  test("applies filters through the checkpoint entry point", async () => {
    const fakePython = join(temporaryDirectory, "python-with-checkpoint");
    writeFileSync(
      fakePython,
      `#!/bin/sh
printf '%s' '{"ok":true,"data":{"checkpointId":"checkpoint-1","checkpointNamespace":"","checkpointTimestamp":"2026-01-02T03:04:05.000Z","messages":[{"role":"human","content":"Run it"},{"role":"ai","content":"","reasoning":[],"toolCalls":[{"id":"call-1","name":"exec","args":{}}]},{"role":"tool","content":"done","toolCallId":"call-1"},{"role":"ai","content":"Finished","reasoning":[],"toolCalls":[]}]}}'
`,
    );
    chmodSync(fakePython, 0o755);

    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-filter",
        pythonExecutable: fakePython,
      },
      filters: { toolResults: "omit" },
    });
    const canonical = await normalizeCheckpointToCanonical({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-filter",
        pythonExecutable: fakePython,
      },
      filters: { toolResults: "omit" },
    });

    expect(result.records.some((record) => record.role === "tool")).toBe(false);
    expect(
      result.records.some(
        (record) => record.role === "assistant" && record.content === null,
      ),
    ).toBe(true);
    expect(canonical.records.some((record) => record.record_type === "tool")).toBe(
      false,
    );
    expect(canonical.config.filters).toEqual({
      toolResults: "omit",
      systemMessages: "omit",
    });
  });
});

function findLangGraphPython(): string | undefined {
  const candidates = [
    process.env.DEEPAGENTS_TEST_PYTHON,
    join(ROOT, ".venv/bin/python"),
    process.env.PYTHON,
    "python3",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = spawnSync(
      candidate,
      [
        "-c",
        "from langgraph.checkpoint.sqlite import SqliteSaver; from langgraph.graph.message import add_messages",
      ],
      { stdio: "ignore" },
    );
    if (result.status === 0) return candidate;
  }
  return undefined;
}
