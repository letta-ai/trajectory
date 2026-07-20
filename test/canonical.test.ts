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
