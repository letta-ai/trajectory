import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeCheckpoint } from "../src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PYTHON = findDeepAgentsPython();
const sdkTest = PYTHON ? test : test.skip;
let temporaryDirectory = "";
let databasePath = "";

beforeAll(() => {
  if (!PYTHON) return;
  temporaryDirectory = mkdtempSync(join(tmpdir(), "trajectory-deepagents-sdk-"));
  databasePath = join(temporaryDirectory, "checkpoint.db");
  const generated = spawnSync(
    PYTHON,
    [join(ROOT, "fixtures/deepagents/generate_sdk_checkpoint.py"), databasePath],
    { encoding: "utf8" },
  );
  if (generated.status !== 0) {
    throw new Error(
      `Could not generate Deep Agents SDK checkpoint: ${generated.stderr || generated.stdout}`,
    );
  }
});

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("Deep Agents SDK checkpoints", () => {
  sdkTest("normalizes a checkpoint created by the real SDK", async () => {
    const result = await normalizeCheckpoint({
      source: "deepagents",
      checkpoint: {
        path: databasePath,
        threadId: "deepagents-sdk-test",
        pythonExecutable: PYTHON!,
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.records[3]).toEqual(
      expect.objectContaining({
        tool_calls: [
          {
            id: "sdk-call-1",
            name: "sdk_verification_tool",
            args: "{}",
          },
        ],
      }),
    );
    expect(result.records[4]).toEqual(
      expect.objectContaining({
        tool_call_id: "sdk-call-1",
        content: "Deep Agents SDK tool result",
      }),
    );
    expect(result.records[5]).toEqual(
      expect.objectContaining({ content: "Deep Agents SDK checkpoint complete." }),
    );
  });
});

function findDeepAgentsPython(): string | undefined {
  const candidates = [
    process.env.DEEPAGENTS_SDK_TEST_PYTHON,
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
        "from deepagents import create_deep_agent; from langgraph.checkpoint.sqlite import SqliteSaver",
      ],
      { stdio: "ignore" },
    );
    if (result.status === 0) return candidate;
  }
  return undefined;
}
