import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { normalizeConversation, validateConversation } from "../src/conversations/index.js";

const schema = new Ajv2020({ strictTuples: false }).compile(JSON.parse(readFileSync(
  new URL("../schema/conversation-v1.schema.json", import.meta.url), "utf8",
)));
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
  return normalizeConversation({ source: "slack", transcript });
}

describe("Slack thread trajectories", () => {
  for (const name of ["thread", "cleanup", "rich-thread"]) {
    test(`synthetic ${name} fixture matches golden and the conversation schema`, () => {
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
      validateConversation(result.records);
      expect(schema(result.records)).toBe(true);

    });
  }

  test("a complete human-only thread is valid, including one standalone message", () => {
    expect(normalize().records.map((r) => r.role)).toEqual([
      "meta",
      "message",
    ]);
    validateConversation(normalize().records);
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

  test("exact message IDs and microsecond ordering are arrival-independent", () => {
    const messages = [
      { ...root, ts: "1700000000.000099", thread_ts: rootTs },
      { ...root, ts: "1700000000.000010", thread_ts: rootTs },
      root,
    ];
    const forward = normalize(envelope(messages));
    expect(forward).toEqual(normalize(envelope([...messages].reverse())));
    expect(forward.records.slice(1).map((r) => r.role === "message" ? r.id : "")).toEqual([
      rootTs, "1700000000.000010", "1700000000.000099",
    ]);
  });

  test("edits preserve message identity without discarding the changed text", () => {
    const before = normalize().records[1];
    const after = normalize(envelope([{ ...root, text: "Updated" }])).records[1];
    expect(after?.id).toBe(before?.id);
    expect(after?.content).toBe("Updated");
  });

  test("identical timestamps in different channels/workspaces retain their scope", () => {
    const first = normalize().records[0];
    expect(normalize(envelope([root], { channel: "COTHER" })).records[0]).not.toEqual(first);
    expect(normalize(envelope([root], { team: "TOTHER" })).records[0]).not.toEqual(first);
  });

  test("a reply-only fragment keeps thread context without fabricating a root", () => {
    const reply = { ...root, ts: "1700000001.000001", thread_ts: rootTs };
    const full = normalize(envelope([root, reply]));
    const fragment = normalize(envelope([reply]));
    const fullReply = full.records[2];
    if (!fullReply) throw new Error("Expected reply");
    expect(fragment.records).toEqual([full.records[0], fullReply]);
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

});
