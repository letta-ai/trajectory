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
      const result = normalizeConversation({
        source: "slack", transcript: JSON.stringify(input.messages), channel: input.channel,
        ...(input.channel_name === undefined ? {} : { channelName: input.channel_name }),
        ...(input.users === undefined ? {} : { users: input.users }),
      });
      expect<unknown>(result).toEqual(expected);
      validateConversation(result.records);
      expect(schema(result.records)).toBe(true);
    });
  }

  test("one channel is one conversation: posts in time order, replies nested once", () => {
    const result = normalize([reply, { ...root, ts: "1700000002.000001", text: "Later" }, root]);
    expect(result.records[0]).toEqual({
      role: "meta", source: "slack", channel: "CEXAMPLE",
      participants: { UONE: { id: "UONE" }, UTWO: { id: "UTWO" } },
    });
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
    expect(thread.speaker).toBe("UONE");
    expect(thread.replies?.[0]?.speaker).toBe("UONE");
    expect(result.records[0].participants).toEqual({ UONE: { id: "UONE" } });
  });

  test("bot-only identities and raw text survive without injected-context filtering", () => {
    const result = normalize([{
      type: "message", ts: rootTs, bot_id: "BONLY",
      text: "<task-notification>quoted data</task-notification>",
    }]);
    expect(post(result)).toMatchObject({
      speaker: "BONLY",
      content: "<task-notification>quoted data</task-notification>",
    });
    expect(result.records[0].participants).toEqual({ BONLY: { id: "BONLY", bot: true } });
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
    expect(fragment.records[1]).toEqual({ id: rootTs, missing_root: true, replies });
    expect(fragment.diagnostics).toMatchObject([{ code: "slack_missing_root" }]);
    validateConversation(fragment.records);
    expect(schema(fragment.records)).toBe(true);
  });

  test("a root that lost its text still anchors its replies as a fragment", () => {
    const result = normalize([{ ...root, text: "", blocks: [{ type: "rich_text" }] }, reply]);
    expect(result.records[1]).toEqual({
      id: rootTs, missing_root: true, replies: [expect.objectContaining({ id: reply.ts })],
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["slack_message_dropped", "slack_missing_root"]);
  });

  test("conflicting copies keep one snapshot, independent of arrival order", () => {
    const edited = { ...root, text: "Updated", edited: { user: "UONE", ts: "1700000009.000001" } };
    expect(post(normalize([edited, root])).content).toBe("Updated");
    expect(normalize([edited, root])).toEqual(normalize([root, edited]));
    const reacted = { ...root, reactions: [{ name: "eyes", count: 2, users: ["UTWO"] }] };
    const fewer = { ...root, reactions: [{ name: "eyes", count: 1, users: ["UTWO"] }] };
    expect(post(normalize([reacted, fewer])).reactions).toEqual({ eyes: 2 });
    expect(normalize([reacted, fewer])).toEqual(normalize([fewer, reacted]));
    const other = { ...root, text: "Other version" };
    expect(normalize([root, other])).toEqual(normalize([other, root]));
    expect(normalize([root, other, root]).diagnostics.map((d) => d.code).sort())
      .toEqual(["slack_conflicting_message", "slack_conflicting_message"]);
  });

  test("copies that disagree on thread or speaker fail", () => {
    expect(() => normalize([reply, { ...reply, thread_ts: "1700000000.000000" }])).toThrow("Conflicting thread");
    expect(() => normalize([root, { ...root, user: "UOTHER" }])).toThrow("Conflicting thread or speaker");
  });

  test("timestamps are ISO seconds while ids keep the exact ts", () => {
    const record = post(normalize([{ ...root, ts: "1700000000.999999" }]));
    expect(record).toMatchObject({ id: "1700000000.999999", timestamp: "2023-11-14T22:13:20Z" });
  });

  test("file attachments become placeholders, including file-only posts", () => {
    const result = normalize([
      { ...root, text: "see attached", files: [{ id: "F1", name: "plan.pdf" }, { id: "F2", title: "Screenshot" }] },
      { ...reply, text: "", subtype: "file_share", files: [{ id: "F3", mode: "tombstone" }] },
    ]);
    expect(post(result).content).toBe("see attached\n[file: plan.pdf]\n[file: Screenshot]");
    expect(post(result).replies?.[0]?.content).toBe("[file]");
    expect(result.diagnostics).toEqual([]);
  });

  test("speakers and mentions share one participant table", () => {
    const users = [
      { id: "UONE", profile: { display_name: "Alex" } },
      { id: "UTWO", profile: { display_name: "Alex" } },
      { id: "UBOT", is_bot: true, profile: { real_name: "Deploy Bot" } },
    ];
    const result = normalize([
      { ...root, text: "<@UTWO> and <@UBOT> and <@UGONE> and <@ULEGACY|legacy>" },
      reply,
    ], "CEXAMPLE", users);
    expect(result.records[0].participants).toEqual({
      "Alex": { id: "UONE" },
      "Alex (2)": { id: "UTWO" },
      "Deploy Bot": { id: "UBOT", bot: true },
      "UGONE": { id: "UGONE" },
      "legacy": { id: "ULEGACY" },
    });
    expect(post(result)).toMatchObject({
      speaker: "Alex",
      content: "@Alex (2) and @Deploy Bot and @UGONE and @legacy",
      replies: [expect.objectContaining({ speaker: "Alex (2)" })],
    });
    expect(normalize([reply, { ...root, text: "<@UTWO> and <@UBOT> and <@UGONE> and <@ULEGACY|legacy>" }],
      "CEXAMPLE", [...users].reverse())).toEqual(result);
  });

  test("an optional channel name is carried once in meta", () => {
    const result = normalizeConversation({
      source: "slack", transcript: JSON.stringify([root]), channel: "CEXAMPLE", channelName: "eng-deploys",
    });
    expect(result.records[0]).toMatchObject({ channel: "CEXAMPLE", channel_name: "eng-deploys" });
    expect(() => normalizeConversation({
      source: "slack", transcript: JSON.stringify([root]), channel: "CEXAMPLE", channelName: " ",
    })).toThrow("channel name");
  });

  test("an empty channel is meta only", () => {
    for (const transcript of ["", "\n", "[]", JSON.stringify({ ok: true, messages: [] })]) {
      const result = normalizeConversation({ source: "slack", transcript, channel: "CEXAMPLE" });
      expect(result).toEqual({
        records: [{ role: "meta", source: "slack", channel: "CEXAMPLE", participants: {} }], diagnostics: [],
      });
      validateConversation(result.records);
      expect(schema(result.records)).toBe(true);
    }
    const joins = normalize([{ ...root, subtype: "channel_join" }]);
    expect(joins.records).toHaveLength(1);
    expect(joins.diagnostics).toMatchObject([{ code: "slack_message_dropped" }]);
  });

  test("channel mismatches, replies before their root, and foreign fields fail", () => {
    expect(() => normalize([{ ...root, channel: "COTHER" }])).toThrow("channel");
    expect(() => normalize([{ ...root, ts: "1699999999.999999", thread_ts: rootTs }])).toThrow("precedes");
    expect(normalize([{ ...root, team: "TANY" }])).toEqual(normalize());
  });

  test("rejects invalid transcripts, timestamps, speakers, and channels", () => {
    for (const transcript of ["{", "{}", "[null]", '{"messages": "x"}', "not json\n"]) {
      expect(() => normalizeConversation({ source: "slack", transcript, channel: "CEXAMPLE" })).toThrow();
    }
    expect(() => normalize([root], "")).toThrow("channel");
    expect(() => normalize([{ ...root, user: undefined }])).toThrow("identity");
    for (const ts of ["not-time", 1700000000.000001, "01700000000.000001", "1700000000.1", "999999999999.999999"]) {
      expect(() => normalize([{ ...root, ts }])).toThrow();
    }
  });
});
