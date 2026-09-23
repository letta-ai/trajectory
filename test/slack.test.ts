import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { normalizeConversation, validateConversation } from "../src/conversations/index.js";
import type { ConversationPost, ConversationThreadFragment } from "../src/conversations/index.js";

const schema = new Ajv2020({ strictTuples: false }).compile(JSON.parse(readFileSync(
  new URL("../schema/conversation-v1.schema.json", import.meta.url), "utf8",
)));
const rootTs = "1700000000.000001";
const root = { type: "message", user: "UONE", ts: rootTs, text: "Hello" };
const reply = { ...root, ts: "1700000001.000001", thread_ts: rootTs, user: "UTWO", text: "Hi" };
function normalize(messages: unknown[] = [root], channel = "CEXAMPLE", users?: unknown[]) {
  return normalizeConversation({
    source: "slack", transcript: JSON.stringify(messages), channel,
    ...(users === undefined ? {} : { users }),
  });
}
function posts(result: ReturnType<typeof normalize>): (ConversationPost | ConversationThreadFragment)[] {
  return result.records.slice(1) as (ConversationPost | ConversationThreadFragment)[];
}
function post(result: ReturnType<typeof normalize>, index = 0): ConversationPost {
  const record = posts(result)[index];
  if (!record || !("speaker" in record)) throw new Error("Expected a post with a speaker");
  return record;
}

describe("Slack channel conversations", () => {
  for (const name of ["thread", "cleanup", "rich-thread", "channel"]) {
    test(`synthetic ${name} fixture matches golden and the conversation schema`, () => {
      const input = JSON.parse(readFileSync(
        new URL(`../fixtures/slack/${name}/input.json`, import.meta.url), "utf8",
      ));
      const expected: unknown = JSON.parse(readFileSync(
        new URL(`../fixtures/slack/${name}/expected.json`, import.meta.url), "utf8",
      ));
      const result = normalize(input.messages, input.channel, input.users);
      expect<unknown>(result).toEqual(expected);
      validateConversation(result.records);
      expect(schema(result.records)).toBe(true);
    });
  }

  test("one channel is one conversation: posts in time order, replies nested once", () => {
    const result = normalize([reply, { ...root, ts: "1700000002.000001", text: "Later" }, root]);
    expect(result.records[0]).toEqual({ role: "meta", source: "slack", channel: "CEXAMPLE" });
    expect(posts(result).map((p) => p.id)).toEqual([rootTs, "1700000002.000001"]);
    expect(post(result).replies?.map((r) => r.id)).toEqual(["1700000001.000001"]);
    expect(post(result, 1)).not.toHaveProperty("replies");
    for (const record of posts(result)) {
      expect(record).not.toHaveProperty("role");
      expect(record).not.toHaveProperty("thread_ts");
    }
  });

  test("accepts JSONL rows, a JSON array, or a conversations.history response", () => {
    const rows = [root, reply];
    const fromArray = normalize(rows);
    const fromJsonl = normalizeConversation({
      source: "slack", channel: "CEXAMPLE", transcript: rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    });
    const fromHistory = normalizeConversation({
      source: "slack", channel: "CEXAMPLE", transcript: JSON.stringify({ ok: true, messages: rows, has_more: false }),
    });
    expect(fromJsonl).toEqual(fromArray);
    expect(fromHistory).toEqual(fromArray);
  });

  test("bot relays do not become assistant turns or inferred people", () => {
    const result = normalize([
      { ...root, text: "*User*\nQuestion", bot_id: "BRELAY" },
      { ...root, ts: "1700000001.000001", thread_ts: rootTs, text: "*Agent*\nAnswer", bot_id: "BRELAY" },
    ]);
    const thread = post(result);
    expect(thread.speaker).toEqual({ id: "UONE" });
    expect(thread.replies?.[0]?.speaker).toEqual({ id: "UONE" });
  });

  test("bot-only identities and raw text survive without injected-context filtering", () => {
    const result = normalize([{
      type: "message", ts: rootTs, bot_id: "BONLY",
      text: "<task-notification>quoted data</task-notification>",
    }]);
    expect(post(result)).toMatchObject({
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
    const forward = normalize(messages);
    expect(forward).toEqual(normalize([...messages].reverse()));
    expect(post(forward).replies?.map((r) => r.id)).toEqual(["1700000000.000010", "1700000000.000099"]);
  });

  test("edits preserve message identity without discarding the changed text", () => {
    const before = post(normalize());
    const after = post(normalize([{ ...root, text: "Updated" }]));
    expect(after.id).toBe(before.id);
    expect(after.content).toBe("Updated");
  });

  test("replies without their root keep the thread id and do not fabricate the root", () => {
    const full = normalize([root, reply]);
    const fragment = normalize([reply]);
    const replies = post(full).replies;
    if (!replies) throw new Error("Expected replies");
    expect(fragment.records[1]).toEqual({ id: rootTs, replies });
    expect(fragment.diagnostics).toMatchObject([{ code: "slack_missing_root" }]);
    validateConversation(fragment.records);
    expect(schema(fragment.records)).toBe(true);
  });

  test("a root that lost its text still anchors its replies as a fragment", () => {
    const result = normalize([{ ...root, text: "", files: [{}] }, reply]);
    expect(result.records[1]).toEqual({ id: rootTs, replies: [expect.objectContaining({ id: reply.ts })] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["slack_message_dropped", "slack_missing_root"]);
  });

  test("conflicting duplicates fail rather than choosing whichever arrived last", () => {
    expect(() => normalize([root, { ...root, text: "Other version" }])).toThrow("Conflicting versions");
    expect(() => normalize([reply, { ...reply, thread_ts: "1700000000.000000" }])).toThrow("Conflicting versions");
  });

  test("channel mismatches, replies before their root, and foreign fields fail", () => {
    expect(() => normalize([{ ...root, channel: "COTHER" }])).toThrow("channel");
    expect(() => normalize([{ ...root, ts: "1699999999.999999", thread_ts: rootTs }])).toThrow("precedes");
    expect(normalize([{ ...root, team: "TANY" }])).toEqual(normalize());
  });

  test("rejects invalid transcripts, timestamps, speakers, channels, and empty results", () => {
    for (const transcript of ["{", "", "[]", "{}", "[null]", '{"messages": "x"}', "not json\n"]) {
      expect(() => normalizeConversation({ source: "slack", transcript, channel: "CEXAMPLE" })).toThrow();
    }
    expect(() => normalize([root], "")).toThrow("channel");
    expect(() => normalize([{ ...root, user: undefined }])).toThrow("identity");
    expect(() => normalize([{ ...root, subtype: "channel_join" }])).toThrow("no supported");
    for (const ts of ["not-time", 1700000000.000001, "01700000000.000001", "1700000000.1", "999999999999.999999"]) {
      expect(() => normalize([{ ...root, ts }])).toThrow();
    }
  });
});
