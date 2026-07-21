import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_SCHEMA_VERSION,
  NORMALIZER_VERSION,
  normalizeToCanonical,
} from "../src/index.js";
import type {
  CanonicalRecord,
  CanonicalResult,
  TrajectorySource,
} from "../src/index.js";
import { decodeDeepAgentsCheckpoint } from "../src/adapters/deepagents.js";
import { buildCanonicalRecords } from "../src/canonical.js";
import { normalizeDecodedSessionInternal } from "../src/core.js";
import { resolveBounds } from "../src/bounds.js";
import type { DeepAgentsCheckpointData } from "../src/index.js";

const canonicalSchema = JSON.parse(
  fixtureText("", "../schema/trajectory-canonical-v1.schema.json"),
) as object;
const validateCanonical = new Ajv2020().compile(canonicalSchema);

const HEX_64 = /^[0-9a-f]{64}$/;

const goldenFixtures = [
  { source: "claude-code", name: "claude-code/tool-call", golden: "claude-code__tool-call" },
  { source: "codex", name: "codex/tool-calls", golden: "codex__tool-calls" },
  { source: "letta", name: "letta/tool-call", golden: "letta__tool-call" },
  { source: "openhands", name: "openhands/tool-calls", golden: "openhands__tool-calls" },
] as const satisfies ReadonlyArray<{
  source: TrajectorySource;
  name: string;
  golden: string;
}>;

describe("canonical golden fixtures", () => {
  for (const fixture of goldenFixtures) {
    test(fixture.name, () => {
      const inputFile =
        fixture.source === "openhands" || fixture.source === "letta"
          ? "input.json"
          : "input.jsonl";
      const transcript = fixtureText(fixture.name, inputFile);
      const expected = JSON.parse(
        fixtureText("canonical", `${fixture.golden}.json`),
      ) as CanonicalResult;

      const result = normalizeToCanonical({ source: fixture.source, transcript });

      expect(result).toEqual(expected);
      expect(validateCanonical(result.records)).toBe(true);
      expect(result.normalizer_version).toBe(NORMALIZER_VERSION);
      expect(result.canonical_schema_version).toBe(CANONICAL_SCHEMA_VERSION);
    });
  }
});

describe("canonical invariants", () => {
  for (const fixture of goldenFixtures) {
    test(fixture.name, () => {
      const inputFile =
        fixture.source === "openhands" || fixture.source === "letta"
          ? "input.json"
          : "input.jsonl";
      const result = normalizeToCanonical({
        source: fixture.source,
        transcript: fixtureText(fixture.name, inputFile),
      });

      const first = result.records[0];
      expect(first?.record_type).toBe("meta");
      expect(first?.source_identity_kind).toBe("synthetic");

      const recordIds = new Set<string>();
      for (const record of result.records) {
        expect(record.record_id).toMatch(HEX_64);
        expect(record.record_hash).toMatch(HEX_64);
        expect(record.content_hash).toMatch(HEX_64);
        expect(record.component_index).toBeGreaterThanOrEqual(0);
        expect(recordIds.has(record.record_id)).toBe(false);
        recordIds.add(record.record_id);
      }

      // Emitted order already sorts by (source_order_id, component_index).
      const orderKeys = result.records.map(
        (record) => `${record.source_order_id}#${record.component_index}`,
      );
      expect([...orderKeys]).toEqual([...orderKeys].sort());
    });
  }
});

describe("determinism", () => {
  test("identity is independent of transport-arrival order", () => {
    const lines = [
      ccUser("u-1", "start the task", "2026-05-01T10:00:00.000Z"),
      ccReasoning("a-1", "thinking about it", "2026-05-01T10:00:01.000Z"),
      ccAssistant("a-2", "here is the plan", "2026-05-01T10:00:02.000Z"),
      ccUser("u-2", "looks good", "2026-05-01T10:00:03.000Z"),
      ccAssistant("a-3", "done", "2026-05-01T10:00:04.000Z"),
    ];

    const forward = identityKeys(canonical(lines));
    const reversed = identityKeys(canonical([...lines].reverse()));
    const rotated = identityKeys(canonical([lines[2]!, lines[4]!, lines[0]!, lines[3]!, lines[1]!]));

    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  test("prefix and appended transcripts keep stable identities", () => {
    const lines = [
      ccUser("u-1", "start the task", "2026-05-01T10:00:00.000Z"),
      ccAssistant("a-1", "first answer", "2026-05-01T10:00:01.000Z"),
      ccUser("u-2", "another question", "2026-05-01T10:00:02.000Z"),
      ccAssistant("a-2", "second answer", "2026-05-01T10:00:03.000Z"),
    ];
    const prefix = byStableId(canonical(lines.slice(0, 2)));
    const full = byStableId(canonical(lines));

    for (const [id, record] of prefix) {
      const later = full.get(id);
      expect(later).toBeDefined();
      expect(later?.record_id).toBe(record.record_id);
      expect(later?.content_hash).toBe(record.content_hash);
      expect(later?.source_order_id).toBe(record.source_order_id);
    }
  });

  test("exact-duplicate records share a record_id for worker dedup", () => {
    const duplicate = ccAssistant("a-1", "identical answer", "2026-05-01T10:00:01.000Z");
    const result = canonical([
      ccUser("u-1", "go", "2026-05-01T10:00:00.000Z"),
      duplicate,
      duplicate,
    ]);
    const answers = result.records.filter((record) => record.content === "identical answer");
    expect(answers).toHaveLength(2);
    expect(answers[0]?.record_id).toBe(answers[1]?.record_id ?? "");
    expect(answers[0]?.content_hash).toBe(answers[1]?.content_hash ?? "");
  });

  test("conflicting versions of one record keep record_id but change content_hash", () => {
    const original = canonical([
      ccUser("u-1", "go", "2026-05-01T10:00:00.000Z"),
      ccAssistant("a-1", "first draft", "2026-05-01T10:00:01.000Z"),
    ]);
    const edited = canonical([
      ccUser("u-1", "go", "2026-05-01T10:00:00.000Z"),
      ccAssistant("a-1", "revised draft", "2026-05-01T10:00:01.000Z"),
    ]);
    const before = original.records.find((record) => record.stable_source_record_id === "a-1");
    const after = edited.records.find((record) => record.stable_source_record_id === "a-1");

    expect(before?.record_id).toBe(after?.record_id ?? "");
    expect(before?.content_hash).not.toBe(after?.content_hash ?? "");
  });

  test("tool linkage resolves when a result arrives before its call", () => {
    const call = ccToolUse("a-1", "call_x", "run", "2026-05-01T10:00:02.000Z");
    const result = ccToolResult("u-2", "call_x", "command output", "2026-05-01T10:00:03.000Z");

    const inOrder = canonical([
      ccUser("u-1", "go", "2026-05-01T10:00:00.000Z"),
      call,
      result,
    ]);
    const reversed = canonical([
      ccUser("u-1", "go", "2026-05-01T10:00:00.000Z"),
      result, // result arrives before its call
      call,
    ]);

    const reversedTool = reversed.records.find((record) => record.record_type === "tool");
    const reversedCall = reversed.records.find(
      (record) => record.record_type === "assistant-tool-call",
    );
    expect(reversedTool?.tool_call_id).toBe("call_x");
    expect(reversedCall?.tool_call_id).toBe("call_x");
    expect(reversed.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "orphan_tool_result",
    );

    // Identity is independent of whether the result or call arrived first.
    const inOrderTool = inOrder.records.find((record) => record.record_type === "tool");
    const inOrderCall = inOrder.records.find(
      (record) => record.record_type === "assistant-tool-call",
    );
    expect(reversedTool?.record_id).toBe(inOrderTool?.record_id ?? "");
    expect(reversedCall?.record_id).toBe(inOrderCall?.record_id ?? "");
  });

  test("content-addressed fallback is flagged and dedupes exact duplicates", () => {
    // Codex has no per-record id; identity falls back to a stable location.
    const result = normalizeToCanonical({
      source: "codex",
      transcript: fixtureText("codex/tool-calls", "input.jsonl"),
    });
    for (const record of result.records) {
      if (record.record_type === "meta") continue;
      expect(record.source_identity_kind).toBe("location");
    }
  });
});

describe("codex chunked-upload source context", () => {
  const meta = codexMeta("sess-1", "/work", "2026-06-01T09:00:00.000Z");
  const u1 = codexMessage("user", "first question", "2026-06-01T09:00:01.000Z");
  const a1 = codexMessage("assistant", "first answer", "2026-06-01T09:00:02.000Z");
  const u2 = codexMessage("user", "second question", "2026-06-01T09:00:03.000Z");
  const a2 = codexMessage("assistant", "second answer", "2026-06-01T09:00:04.000Z");

  test("identity matches between full transcript and a standalone later chunk", () => {
    const full = normalizeToCanonical({
      source: "codex",
      transcript: [meta, u1, a1, u2, a2].join("\n"),
    });
    const baseByteOffset = utf8Len([meta, u1, a1].join("\n") + "\n");
    const chunk = normalizeToCanonical({
      source: "codex",
      transcript: [u2, a2].join("\n"),
      sourceContext: { groupId: "sess-1", baseByteOffset },
    });

    const fullSecond = full.records.find((record) => record.content === "second question");
    const chunkSecond = chunk.records.find((record) => record.content === "second question");
    expect(chunkSecond?.stable_source_record_id).toBe(fullSecond?.stable_source_record_id ?? "");
    expect(chunkSecond?.record_id).toBe(fullSecond?.record_id ?? "");
    expect(chunkSecond?.source_group_id).toBe("sess-1");

    // The authoritative meta is emitted with the initial chunk only; a
    // continuation (baseByteOffset > 0) omits meta to avoid a false conflict.
    expect(full.records[0]?.record_type).toBe("meta");
    expect(chunk.records.some((record) => record.record_type === "meta")).toBe(false);
  });

  test("requires a resolved group for Codex rather than a silent default", () => {
    expect(() =>
      normalizeToCanonical({ source: "codex", transcript: [u1, a1].join("\n") }),
    ).toThrow(
      expect.objectContaining({ code: "source_group_required" }),
    );
  });

  test("fails when detected and provided groups disagree", () => {
    expect(() =>
      normalizeToCanonical({
        source: "codex",
        transcript: [meta, u1, a1].join("\n"),
        sourceContext: { groupId: "other-session" },
      }),
    ).toThrow(
      expect.objectContaining({ code: "source_group_conflict" }),
    );
  });
});

describe("canonical continuation (partial) chunks", () => {
  test("a single-role continuation chunk is accepted", () => {
    // A continuation that only contains assistant records must not be rejected
    // for missing a user turn.
    const chunk = normalizeToCanonical({
      source: "codex",
      transcript: [
        codexMessage("assistant", "continued answer one", "2026-06-01T09:10:00.000Z"),
        codexMessage("assistant", "continued answer two", "2026-06-01T09:10:01.000Z"),
      ].join("\n"),
      sourceContext: { groupId: "sess-1", baseByteOffset: 4096 },
    });
    expect(chunk.records.filter((record) => record.record_type === "assistant")).toHaveLength(2);
    expect(chunk.records.some((record) => record.record_type === "meta")).toBe(false);
  });

  test("a tool result whose call was in an earlier chunk is kept, not dropped", () => {
    const result = normalizeToCanonical({
      source: "codex",
      transcript: codexFunctionOutput("call_earlier", "command output", "2026-06-01T09:10:05.000Z"),
      sourceContext: { groupId: "sess-1", baseByteOffset: 8192 },
    });
    const tool = result.records.find((record) => record.record_type === "tool");
    expect(tool?.tool_call_id).toBe("call_earlier");
    expect(tool?.tool_result_json).toBe("command output");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "orphan_tool_result",
    );
  });

  test("an offset-zero partial chunk is lenient but still emits meta", () => {
    // Offset 0 is the initial range, not necessarily a complete transcript: an
    // explicit partial signal relaxes validation while meta is still emitted.
    const chunk = normalizeToCanonical({
      source: "codex",
      transcript: [
        codexMeta("sess-1", "/work", "2026-06-01T09:00:00.000Z"),
        codexMessage("assistant", "opening statement", "2026-06-01T09:00:01.000Z"),
      ].join("\n"),
      sourceContext: { partial: true },
    });
    expect(chunk.records[0]?.record_type).toBe("meta");
    expect(chunk.records.filter((record) => record.record_type === "assistant")).toHaveLength(1);
  });

  test("strict normalizeToCanonical still rejects a single-role full transcript", () => {
    expect(() =>
      normalizeToCanonical({
        source: "codex",
        transcript: [
          codexMeta("sess-1", "/work", "2026-06-01T09:00:00.000Z"),
          codexMessage("assistant", "only assistant", "2026-06-01T09:00:01.000Z"),
        ].join("\n"),
      }),
    ).toThrow(expect.objectContaining({ code: "missing_user_records" }));
  });

  test("a one-row v3 local Letta continuation is routed through the local parser", () => {
    const chunk = normalizeToCanonical({
      source: "letta",
      transcript: lettaLocalMessage("assistant", "single continuation row"),
      sourceContext: { groupId: "letta-session", baseByteOffset: 2048 },
    });
    expect(chunk.records.filter((record) => record.record_type === "assistant")).toHaveLength(1);
  });
});

describe("local letta chunked-upload byte anchoring", () => {
  // Multibyte content before the split proves the anchor is bytes, not chars.
  const m1 = lettaLocalMessage("user", "héllo 😀 first");
  const m2 = lettaLocalMessage("assistant", "réply 😀 one");
  const m3 = lettaLocalMessage("user", "second question");
  const m4 = lettaLocalMessage("assistant", "second answer");
  const session = JSON.stringify({ type: "session", version: 3, timestamp: "2026-06-01T09:00:00.000Z" });

  test("identity matches between full file and a standalone continuation", () => {
    const full = normalizeToCanonical({
      source: "letta",
      transcript: [session, m1, m2, m3, m4].join("\n"),
      sourceContext: { groupId: "letta-session" },
    });
    const baseByteOffset = utf8Len([session, m1, m2].join("\n") + "\n");
    const chunk = normalizeToCanonical({
      source: "letta",
      transcript: [m3, m4].join("\n"),
      sourceContext: { groupId: "letta-session", baseByteOffset },
    });

    const fullSecond = full.records.find((record) => record.content === "second question");
    const chunkSecond = chunk.records.find((record) => record.content === "second question");
    expect(chunkSecond?.source_identity_kind).toBe("location");
    expect(chunkSecond?.stable_source_record_id).toBe(fullSecond?.stable_source_record_id ?? "");
    expect(chunkSecond?.record_id).toBe(fullSecond?.record_id ?? "");
    expect(chunk.records.some((record) => record.record_type === "meta")).toBe(false);
  });
});

describe("deepagents thread grouping", () => {
  test("root-namespace threads do not collide on offset identities", () => {
    const first = canonicalCheckpoint(checkpointData("thread-a", ""));
    const second = canonicalCheckpoint(checkpointData("thread-b", ""));

    expect(first[1]?.source_group_id).toBe(JSON.stringify(["thread-a", ""]));
    expect(second[1]?.source_group_id).toBe(JSON.stringify(["thread-b", ""]));
    const firstIds = new Set(first.map((record) => record.record_id));
    for (const record of second) {
      expect(firstIds.has(record.record_id)).toBe(false);
    }
  });

  test("distinct namespaces in one thread are distinct groups", () => {
    const root = canonicalCheckpoint(checkpointData("thread-a", ""));
    const sub = canonicalCheckpoint(checkpointData("thread-a", "sub"));
    expect(root[1]?.source_group_id).toBe(JSON.stringify(["thread-a", ""]));
    expect(sub[1]?.source_group_id).toBe(JSON.stringify(["thread-a", "sub"]));
    expect(sub[1]?.record_id).not.toBe(root[1]?.record_id ?? "");
  });

  test("a literal tuple-shaped thread id cannot collide with a real pair", () => {
    // Thread whose id is literally `["thread-a",""]` (root) must not collide with
    // thread `thread-a` + namespace `""` — uniform encoding wraps each level.
    const literal = canonicalCheckpoint(checkpointData(JSON.stringify(["thread-a", ""]), ""));
    const real = canonicalCheckpoint(checkpointData("thread-a", ""));
    expect(literal[1]?.source_group_id).not.toBe(real[1]?.source_group_id ?? "");
    expect(literal[1]?.record_id).not.toBe(real[1]?.record_id ?? "");
  });
});

describe("openhands linkage independent of arrival order", () => {
  test("an observation before its action still resolves the call", () => {
    const events = [
      { id: "e1", kind: "MessageEvent", source: "user", timestamp: "2026-07-03T10:00:00.000Z", llm_message: { content: [{ type: "text", text: "go" }] } },
      { id: "e2", kind: "ObservationEvent", action_id: "e3", timestamp: "2026-07-03T10:00:02.000Z", observation: { content: [{ type: "text", text: "command output" }] } },
      { id: "e3", kind: "ActionEvent", timestamp: "2026-07-03T10:00:01.000Z", tool_name: "run", action: { kind: "run", command: "ls" } },
    ];
    const result = normalizeToCanonical({ source: "openhands", transcript: JSON.stringify(events) });

    const tool = result.records.find((record) => record.record_type === "tool");
    const call = result.records.find((record) => record.record_type === "assistant-tool-call");
    expect(tool?.tool_call_id).toBe("oh_e3");
    expect(call?.tool_call_id).toBe("oh_e3");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "orphan_tool_result",
    );
  });
});

describe("timestamp-free determinism", () => {
  test("native records without timestamps keep stable order identity", () => {
    const lines = [
      ccUserNoTs("u-1", "start"),
      ccAssistantNoTs("a-1", "answer one"),
      ccUserNoTs("u-2", "again"),
      ccAssistantNoTs("a-2", "answer two"),
    ];
    const forward = identityKeys(canonical(lines));
    const reversed = identityKeys(canonical([...lines].reverse()));
    expect(reversed).toEqual(forward);
  });
});

describe("meta determinism", () => {
  test("meta content resolves from source chronology, not arrival order", () => {
    const early = ccUserCwd("u-1", "first", "/repo/early", "2026-05-01T10:00:00.000Z");
    const late = ccAssistantCwd("a-1", "second", "/repo/late", "2026-05-01T10:00:05.000Z");

    const forward = canonical([early, late]);
    const reversed = canonical([late, early]);
    const forwardMeta = forward.records[0];
    const reversedMeta = reversed.records[0];

    expect(forwardMeta?.record_type).toBe("meta");
    // cwd comes from the chronologically-earliest record regardless of order.
    expect(JSON.parse(forwardMeta?.record_json ?? "{}").cwd).toBe("/repo/early");
    expect(reversedMeta?.content_hash).toBe(forwardMeta?.content_hash ?? "");
    expect(reversedMeta?.record_hash).toBe(forwardMeta?.record_hash ?? "");
  });

  test("multiple Claude Code session ids are rejected", () => {
    const lines = [
      JSON.stringify({ type: "user", uuid: "u-1", sessionId: "s-1", timestamp: "2026-05-01T10:00:00.000Z", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", uuid: "a-1", sessionId: "s-2", timestamp: "2026-05-01T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
    ];
    expect(() => canonical(lines)).toThrow(
      expect.objectContaining({ code: "source_group_conflict" }),
    );
  });
});

describe("diagnostics surfacing", () => {
  test("noisy Claude Code records are dropped with diagnostics", () => {
    const result = canonical([
      ccUser("u-0", "<command-name>/clear</command-name>", "2026-05-01T09:59:59.000Z"),
      sidechainLine("s-0", "2026-05-01T09:59:59.500Z"),
      ccUser("u-1", "real request", "2026-05-01T10:00:00.000Z"),
      ccAssistant("a-1", "real answer", "2026-05-01T10:00:01.000Z"),
    ]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("noise_record_dropped");
    expect(codes).toContain("sidechain_record_dropped");
    const contents = result.records.map((record) => record.content);
    expect(contents).not.toContain("<command-name>/clear</command-name>");
    expect(contents).toContain("real request");
  });

  test("malformed input lines produce diagnostics but still normalize", () => {
    const result = canonical([
      "{ this is not valid json",
      ccUser("u-1", "real request", "2026-05-01T10:00:00.000Z"),
      ccAssistant("a-1", "real answer", "2026-05-01T10:00:01.000Z"),
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "invalid_json_line",
    );
    expect(result.records.some((record) => record.content === "real answer")).toBe(true);
  });
});

function canonical(lines: string[]): CanonicalResult {
  return normalizeToCanonical({ source: "claude-code", transcript: lines.join("\n") });
}

function identityKeys(result: CanonicalResult): string[] {
  return result.records
    .filter((record) => record.record_type !== "meta")
    .map(
      (record) =>
        `${record.stable_source_record_id}|${record.source_order_id}|${record.content_hash}|${record.record_id}`,
    )
    .sort();
}

function byStableId(result: CanonicalResult): Map<string, CanonicalRecord> {
  const map = new Map<string, CanonicalRecord>();
  for (const record of result.records) {
    if (record.record_type === "meta") continue;
    map.set(`${record.stable_source_record_id}#${record.component_index}`, record);
  }
  return map;
}

function ccUser(uuid: string, content: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "session-fixture",
    timestamp,
    message: { role: "user", content },
  });
}

function ccAssistant(uuid: string, text: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: "session-fixture",
    timestamp,
    message: { role: "assistant", model: "test-model", content: [{ type: "text", text }] },
  });
}

function ccReasoning(uuid: string, text: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: "session-fixture",
    timestamp,
    message: {
      role: "assistant",
      model: "test-model",
      content: [{ type: "thinking", thinking: text }],
    },
  });
}

function ccUserNoTs(uuid: string, content: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "session-fixture",
    message: { role: "user", content },
  });
}

function ccAssistantNoTs(uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: "session-fixture",
    message: { role: "assistant", model: "test-model", content: [{ type: "text", text }] },
  });
}

function ccUserCwd(uuid: string, content: string, cwd: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "session-fixture",
    cwd,
    timestamp,
    message: { role: "user", content },
  });
}

function ccAssistantCwd(uuid: string, text: string, cwd: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: "session-fixture",
    cwd,
    timestamp,
    message: { role: "assistant", model: "test-model", content: [{ type: "text", text }] },
  });
}

function lettaLocalMessage(role: "user" | "assistant", content: string): string {
  // Version-3 wrapper row with no native message id, so identity uses the byte anchor.
  return JSON.stringify({ type: "message", message: { role, content } });
}

function codexMeta(id: string, cwd: string, timestamp: string): string {
  return JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp } });
}

function codexMessage(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

function codexFunctionOutput(callId: string, output: string, timestamp: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: { type: "function_call_output", call_id: callId, output },
  });
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

function checkpointData(threadId: string, checkpointNamespace: string): DeepAgentsCheckpointData {
  return {
    threadId,
    checkpointId: "ckpt-1",
    checkpointNamespace,
    checkpointTimestamp: "2026-07-01T12:00:00.000Z",
    messages: [
      { role: "human", content: "do the thing" },
      { role: "ai", content: "done", reasoning: [], toolCalls: [] },
    ],
  };
}

function canonicalCheckpoint(data: DeepAgentsCheckpointData): CanonicalRecord[] {
  const internal = normalizeDecodedSessionInternal(
    decodeDeepAgentsCheckpoint(data),
    resolveBounds(undefined),
  );
  return buildCanonicalRecords(internal, {
    groupId: internal.context.sourceGroupId ?? "default",
    baseByteOffset: 0,
    emitMeta: true,
  });
}

function ccToolUse(uuid: string, callId: string, name: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: "session-fixture",
    timestamp,
    message: {
      role: "assistant",
      model: "test-model",
      content: [{ type: "tool_use", id: callId, name, input: { arg: "value" } }],
    },
  });
}

function ccToolResult(uuid: string, callId: string, text: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "session-fixture",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content: text }],
    },
  });
}

function sidechainLine(uuid: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    isSidechain: true,
    sessionId: "session-fixture",
    timestamp,
    message: { role: "user", content: "sidechain noise" },
  });
}

function fixtureText(name: string, file: string): string {
  const relative = name ? `../fixtures/${name}/${file}` : file;
  const url = new URL(relative, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}
