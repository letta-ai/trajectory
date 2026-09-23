import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import {
  listTrajectories,
  normalizeToCanonical,
  normalizeTranscript,
  validateTranscript,
} from "../src/index.js";

const schema = new Ajv2020().compile(
  JSON.parse(
    readFileSync(
      new URL("../schema/trajectory-v1.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const canonicalSchema = new Ajv2020().compile(
  JSON.parse(
    readFileSync(
      new URL("../schema/trajectory-canonical-v1.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const rootTs = "1700000000.000001";
const root = { type: "message", user: "UONE", ts: rootTs, text: "Hello" };
function envelope(
  messages: unknown[] = [root],
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    team: "TEXAMPLE",
    channel: "CEXAMPLE",
    thread_ts: rootTs,
    messages,
    ...extra,
  });
}
function normalize(transcript = envelope()) {
  return normalizeTranscript({ source: "slack", transcript });
}
function canonical(transcript = envelope()) {
  return normalizeToCanonical({ source: "slack", transcript });
}

describe("Slack thread trajectories", () => {
  for (const name of ["thread", "cleanup"]) {
    test(`synthetic ${name} fixture matches golden and both schemas`, () => {
      const input = readFileSync(
        new URL(`../fixtures/slack/${name}/input.json`, import.meta.url),
        "utf8",
      );
      const expected: unknown = JSON.parse(
        readFileSync(
          new URL(`../fixtures/slack/${name}/expected.json`, import.meta.url),
          "utf8",
        ),
      );
      const result = normalize(input);
      expect<unknown>(result).toEqual(expected);
      validateTranscript(result.records);
      expect(schema(result.records)).toBe(true);
      const projected = canonical(input);
      expect(canonicalSchema(projected.records)).toBe(true);
      expect(
        projected.records.map((row) => JSON.parse(row.record_json)),
      ).toEqual(result.records);
    });
  }

  test("a complete human-only thread is valid, including one standalone message", () => {
    expect(normalize().records.map((r) => r.role)).toEqual([
      "meta",
      "message",
    ]);
    validateTranscript(normalize().records);
  });

  test("bot relays do not become assistant turns or inferred people", () => {
    const result = normalize(
      envelope([
        { ...root, text: "*User*\nQuestion", bot_id: "BRELAY" },
        {
          ...root,
          ts: "1700000001.000001",
          thread_ts: rootTs,
          text: "*Agent*\nAnswer",
          bot_id: "BRELAY",
        },
      ]),
    );
    expect(result.records.slice(1).map((r) => r.role)).toEqual([
      "message",
      "message",
    ]);
    for (const record of result.records.slice(1)) {
      if (record.role !== "message")
        throw new Error("Expected a Slack post");
      expect(record.speaker).toEqual({ id: "UONE" });
    }
  });

  test("bot-only identities and raw text survive without injected-context filtering", () => {
    const result = normalize(
      envelope([
        {
          type: "message",
          ts: rootTs,
          bot_id: "BONLY",
          text: "<task-notification>quoted data</task-notification>",
        },
      ]),
    );
    expect(result.records[1]).toMatchObject({
      speaker: { id: "BONLY" },
      content: "<task-notification>quoted data</task-notification>",
    });
  });

  test("canonical identities and microsecond ordering are arrival-independent", () => {
    const replies = [
      { ...root, ts: "1700000000.000099", thread_ts: rootTs },
      { ...root, ts: "1700000000.000010", thread_ts: rootTs },
      root,
    ];
    const forward = canonical(envelope(replies));
    const reverse = canonical(envelope([...replies].reverse()));
    expect(forward).toEqual(reverse);
    const rows = forward.records.slice(1);
    expect(rows.map((r) => r.source_order_id)).toEqual(
      rows.map((r) => r.source_order_id).sort(),
    );
    expect(new Set(rows.map((r) => r.record_id)).size).toBe(3);
    expect(rows.every((r) => r.source_identity_kind === "native")).toBe(true);
    expect(rows[0]?.source_group_id).toBe(
      JSON.stringify(["TEXAMPLE", "CEXAMPLE", rootTs]),
    );
  });

  test("edited snapshots retain identity but change semantic hash", () => {
    const before = canonical().records[1];
    const after = canonical(
      envelope([
        { ...root, text: "Updated", edited: { ts: "1700000009.000001" } },
      ]),
    ).records[1];
    expect(after?.record_id).toBe(before?.record_id);
    expect(after?.content_hash).not.toBe(before?.content_hash);
    expect(after?.source_order_id).toBe(before?.source_order_id);
    expect(
      canonical(envelope([{ ...root, user: "UOTHER" }])).records[1]
        ?.content_hash,
    ).not.toBe(before?.content_hash);
  });

  test("different channels/workspaces cannot collide", () => {
    const id = canonical().records[1]?.record_id;
    expect(
      canonical(envelope([root], { channel: "COTHER" })).records[1]
        ?.record_id,
    ).not.toBe(id);
    expect(
      canonical(envelope([root], { team: "TOTHER" })).records[1]
        ?.record_id,
    ).not.toBe(id);
  });

  test("a cross-file reply fragment preserves the full-thread canonical identity", () => {
    const reply = { ...root, ts: "1700000001.000001", thread_ts: rootTs };
    const full = canonical(envelope([root, reply]));
    const partial = normalizeToCanonical({
      source: "slack",
      transcript: envelope([reply]),
      sourceContext: { partial: true, baseByteOffset: 1000 },
    });
    expect(partial.records).toEqual(full.records.slice(2));
  });

  test("explicit source group cannot override Slack identity", () => {
    expect(() =>
      normalizeToCanonical({
        source: "slack",
        transcript: envelope(),
        sourceContext: { groupId: "wrong" },
      }),
    ).toThrow("conflicts");
  });

  test("conflicting duplicates fail rather than choosing whichever arrived last", () => {
    expect(() =>
      normalize(envelope([root, { ...root, text: "Other version" }])),
    ).toThrow("Conflicting versions");
  });

  test("foreign threads, workspace/channel mismatches, and replies before the root fail", () => {
    for (const message of [
      { ...root, ts: "1700000001.000001" },
      { ...root, team: "TOTHER" },
      { ...root, channel: "COTHER" },
      { ...root, ts: "1699999999.999999", thread_ts: rootTs },
    ])
      expect(() => normalize(envelope([message]))).toThrow();
  });

  test("rejects invalid envelopes, timestamps, speakers, and empty results", () => {
    for (const input of [
      "{",
      "[]",
      "{}",
      envelope([], {}),
      envelope([null]),
      envelope([root], { channel: "" }),
      envelope([{ ...root, user: undefined }]),
    ]) {
      expect(() => normalize(input)).toThrow();
    }
    for (const ts of [
      "not-time",
      1700000000.000001,
      "01700000000.000001",
      "1700000000.1",
      "999999999999.999999",
    ]) {
      expect(() =>
        normalize(envelope([{ ...root, ts }], { thread_ts: ts })),
      ).toThrow();
    }
  });

  test("runtime validator rejects malformed/mixed Slack records and keeps agent invariants", () => {
    const record = normalize().records[1];
    if (!record || record.role !== "message")
      throw new Error("Expected Slack message");
    const meta = normalize().records[0];
    for (const bad of [
      { ...record, speaker: {} },
      { ...record, speaker: { id: 42 } },
      { ...record, id: "" },
      { ...record, timestamp: "bad" },
      { ...record, extra: true },
    ])
      expect(() => validateTranscript([meta, bad])).toThrow();
    expect(() => validateTranscript([meta, record, record])).toThrow();
    expect(() =>
      validateTranscript([
        meta,
        { role: "user", content: "Hello", timestamp: record.timestamp },
      ]),
    ).toThrow();
    expect(() =>
      validateTranscript([{ role: "meta", source: "codex" }, record]),
    ).toThrow();
    expect(() =>
      validateTranscript([
        { role: "meta", source: "codex" },
        { role: "user", content: "Hello", timestamp: record.timestamp },
      ]),
    ).toThrow("assistant");
    expect(() => validateTranscript([meta])).toThrow();
  });

  test("Slack is export-only, not an invented local store", async () => {
    await expect(listTrajectories({ source: "slack" })).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });
});
