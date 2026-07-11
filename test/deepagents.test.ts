import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEEP_AGENTS_CODE_DEFAULT_DATABASE_PATH,
  loadDeepAgentsCheckpoint,
  normalizeCheckpoint,
  normalizeDeepAgentsCode,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "fixtures/deepagents/checkpoint.db");
const PYTHON = findLangGraphPython();
const integrationTest = PYTHON ? test : test.skip;
let temporaryDirectory = "";
let databasePath = "";
let deepAgentsCodeHome = "";

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "trajectory-deepagents-"));
  databasePath = join(temporaryDirectory, "checkpoint.db");
  copyFileSync(FIXTURE, databasePath);
  deepAgentsCodeHome = join(temporaryDirectory, "home");
  const stateDirectory = join(deepAgentsCodeHome, ".deepagents", ".state");
  mkdirSync(stateDirectory, { recursive: true });
  copyFileSync(FIXTURE, join(stateDirectory, "sessions.db"));
});

describe("Deep Agents Code local wrapper", () => {
  test("resolves HOME at call time and delegates checkpoint selection", async () => {
    const fakePython = join(temporaryDirectory, "deepagents-code-fake-python");
    const capturedRequest = join(temporaryDirectory, "deepagents-code-request.json");
    const response = JSON.stringify({
      ok: true,
      data: {
        checkpointId: "checkpoint-selected",
        checkpointNamespace: "subagent",
        checkpointTimestamp: "2026-01-02T03:04:05Z",
        messages: [
          {
            role: "human",
            content: "Delegated user",
            timestamp: "2026-01-02T03:04:05Z",
          },
          {
            role: "ai",
            content: "Delegated response",
            reasoning: [],
            toolCalls: [],
            timestamp: "2026-01-02T03:04:06Z",
          },
        ],
      },
    });
    writeFileSync(
      fakePython,
      `#!/bin/sh\ncat > "$TRAJECTORY_DEEPAGENTS_CODE_CAPTURE"\nprintf '%s' '${response}'\n`,
    );
    chmodSync(fakePython, 0o755);
    const originalCapture = process.env.TRAJECTORY_DEEPAGENTS_CODE_CAPTURE;
    process.env.TRAJECTORY_DEEPAGENTS_CODE_CAPTURE = capturedRequest;
    let result: Awaited<ReturnType<typeof normalizeDeepAgentsCode>>;
    try {
      result = await withDeepAgentsCodeHome(() =>
        normalizeDeepAgentsCode({
          threadId: "thread-selected",
          checkpointNamespace: "subagent",
          checkpointId: "checkpoint-selected",
          pythonExecutable: fakePython,
        }),
      );
    } finally {
      if (originalCapture === undefined) {
        delete process.env.TRAJECTORY_DEEPAGENTS_CODE_CAPTURE;
      } else {
        process.env.TRAJECTORY_DEEPAGENTS_CODE_CAPTURE = originalCapture;
      }
    }

    expect(
      JSON.parse(readFileSync(capturedRequest, "utf8")),
    ).toEqual({
      path: join(deepAgentsCodeHome, ".deepagents", ".state", "sessions.db"),
      threadId: "thread-selected",
      checkpointNamespace: "subagent",
      checkpointId: "checkpoint-selected",
    });
    expect(result.records).toEqual([
      { role: "meta", source: "deepagents-code" },
      {
        role: "user",
        content: "Delegated user",
        timestamp: "2026-01-02T03:04:05.000Z",
      },
      {
        role: "assistant",
        content: "Delegated response",
        timestamp: "2026-01-02T03:04:06.000Z",
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  integrationTest("uses the fixed default path and retags only meta source", async () => {
    const generic = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-123",
        checkpointNamespace: "sdk",
        pythonExecutable: PYTHON!,
      },
    });
    const result = await withDeepAgentsCodeHome(() =>
      normalizeDeepAgentsCode({
        threadId: "thread-123",
        checkpointNamespace: "sdk",
        pythonExecutable: PYTHON!,
      }),
    );
    const genericMeta = generic.records[0];
    if (!genericMeta || genericMeta.role !== "meta") {
      throw new Error("Generic checkpoint fixture did not produce metadata.");
    }

    expect(DEEP_AGENTS_CODE_DEFAULT_DATABASE_PATH).toBe(
      "~/.deepagents/.state/sessions.db",
    );
    expect(result).toEqual({
      ...generic,
      records: [
        { ...genericMeta, source: "deepagents-code" },
        ...generic.records.slice(1),
      ],
    });
  });

  integrationTest("forwards explicit checkpoint selection and bounds", async () => {
    const result = await withDeepAgentsCodeHome(() =>
      normalizeDeepAgentsCode({
        threadId: "thread-123",
        checkpointNamespace: "sdk",
        checkpointId: "00000000-0000-6000-8000-000000000001",
        pythonExecutable: PYTHON!,
        bounds: { toolResults: { maxCharacters: 8, strategy: "head" } },
      }),
    );

    expect(result.records[0]).toEqual(
      expect.objectContaining({
        role: "meta",
        source: "deepagents-code",
        cwd: "/workspace/deep-agent",
      }),
    );
    expect(result.records.at(-1)).toEqual(
      expect.objectContaining({ role: "tool", content: "Sunny, …" }),
    );
    expect(result.records.some((record) =>
      record.role === "assistant" &&
      record.content === "It is sunny and 22 C in Paris."
    )).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "tool_result_truncated",
    );
  });

  integrationTest("forwards a non-root checkpoint namespace", async () => {
    const result = await withDeepAgentsCodeHome(() =>
      normalizeDeepAgentsCode({
        threadId: "thread-123",
        checkpointNamespace: "other",
        pythonExecutable: PYTHON!,
      }),
    );

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
    expect(result.records[0]).toEqual({
      role: "meta",
      source: "deepagents-code",
    });
    expect(result.records[1]).toEqual(
      expect.objectContaining({ content: "Other namespace" }),
    );
  });

  test("requires an explicit non-empty threadId before starting Python", async () => {
    await expect(
      normalizeDeepAgentsCode({
        threadId: "",
        pythonExecutable: join(temporaryDirectory, "missing-python"),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });
});

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("Deep Agents Python checkpoints", () => {
  integrationTest("loads latest state with delta history and pending writes", async () => {
    const checkpoint = await loadDeepAgentsCheckpoint({
      path: databasePath,
      threadId: "thread-123",
      checkpointNamespace: "sdk",
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
        checkpointNamespace: "sdk",
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

  integrationTest("selects an explicit checkpoint id", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-123",
        checkpointNamespace: "sdk",
        checkpointId: "00000000-0000-6000-8000-000000000001",
        pythonExecutable: PYTHON!,
      },
    });

    expect(result.records.some((record) =>
      record.role === "assistant" &&
      record.content === "It is sunny and 22 C in Paris."
    )).toBe(false);
    expect(result.records.at(-1)).toEqual(
      expect.objectContaining({ role: "tool", content: "Sunny, 22 C" }),
    );
  });

  integrationTest("selects a checkpoint namespace", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-123",
        checkpointNamespace: "other",
        pythonExecutable: PYTHON!,
      },
    });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
    expect(result.records[1]).toEqual(
      expect.objectContaining({ content: "Other namespace" }),
    );
  });

  integrationTest("applies LangGraph Overwrite message semantics", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "thread-123",
        checkpointNamespace: "overwrite",
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
        checkpointNamespace: "sdk",
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

async function withDeepAgentsCodeHome<T>(operation: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  process.env.HOME = deepAgentsCodeHome;
  try {
    return await operation();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}
