import { expect, test } from "bun:test";
import { groupSlackMessages, normalizeConversation, normalizeConversations } from "../src/conversations/index.js";

const context = { team: "TEXAMPLE", channel: "CEXAMPLE" };
const root = { type: "message", user: "UALICE", ts: "1700000000.000001", thread_ts: "1700000000.000001", text: "root", reply_count: 1 };
const reply = { type: "message", user: "UBOB", ts: "1700000001.000001", thread_ts: "1700000000.000001", text: "reply" };
const standalone = { type: "message", user: "UCAROL", ts: "1700000002.000001", text: ":eyes:" };
const orphan = { type: "message", user: "UBOB", ts: "1699999999.000002", thread_ts: "1699999990.000001", text: "reply to a root outside this page" };

test("groups one channel's history into thread envelopes the adapter accepts", () => {
  const threads = groupSlackMessages([reply, standalone, root, orphan], context);
  expect(threads.map((t) => t.thread_ts)).toEqual([
    "1699999990.000001", "1700000000.000001", "1700000002.000001",
  ]);
  expect(threads[1]?.messages).toEqual([reply, root]);
  for (const thread of threads) {
    expect(thread.team).toBe("TEXAMPLE");
    expect(thread.channel).toBe("CEXAMPLE");
    const result = normalizeConversation({ source: "slack", transcript: JSON.stringify(thread) });
    expect(result.records[0]).toMatchObject({ role: "meta", conversation_id: thread.thread_ts });
  }
  const standaloneResult = normalizeConversation({
    source: "slack", transcript: JSON.stringify(threads[2]),
  });
  expect(standaloneResult.records[1]).toMatchObject({ content: ":eyes:" });
  expect(standaloneResult.records[1]).not.toHaveProperty("metadata");
});

test("carries caller context through and leaves message objects untouched", () => {
  const users = [{ id: "UALICE", profile: { display_name: "Alice" } }];
  const [thread] = groupSlackMessages([root], { ...context, users });
  expect(thread?.users).toBe(users);
  expect(thread?.messages[0]).toBe(root);
  const result = normalizeConversation({ source: "slack", transcript: JSON.stringify(thread) });
  expect(result.records[1]).toMatchObject({ speaker: { id: "UALICE", name: "Alice" } });
});

test("does not guess channel or team and rejects rows it cannot place", () => {
  expect(() => groupSlackMessages([{ type: "message", user: "U1", text: "no ts" }], context)).toThrow("timestamp");
  expect(() => groupSlackMessages(["not an object"], context)).toThrow("objects");
  expect(() => normalizeConversation({
    source: "slack",
    transcript: JSON.stringify({ ...groupSlackMessages([root], context)[0], channel: "" }),
  })).toThrow("channel");
});

test("normalizeConversations takes a raw dump and returns one conversation per thread", () => {
  const rows = [reply, standalone, root];
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const fromJsonl = normalizeConversations({ source: "slack", transcript: jsonl, context });
  const fromArray = normalizeConversations({ source: "slack", transcript: JSON.stringify(rows), context });
  const fromHistory = normalizeConversations({
    source: "slack", transcript: JSON.stringify({ ok: true, messages: rows, has_more: false }), context,
  });
  expect(fromArray).toEqual(fromJsonl);
  expect(fromHistory).toEqual(fromJsonl);
  expect(fromJsonl.conversations.map((c) => c.records[0])).toMatchObject([
    { conversation_id: "1700000000.000001", source_metadata: context },
    { conversation_id: "1700000002.000001", source_metadata: context },
  ]);
  expect(fromJsonl.conversations[0]?.records).toHaveLength(3);
  expect(fromJsonl.conversations.every((c) => c.diagnostics.length === 0)).toBe(true);
});

test("normalizeConversations keeps diagnostics per thread and requires real context", () => {
  const fileOnly = { type: "message", user: "UBOB", ts: "1700000001.000002", thread_ts: "1700000000.000001", text: "", files: [{}] };
  const { conversations } = normalizeConversations({
    source: "slack", transcript: JSON.stringify([root, fileOnly, standalone]),
    context: { ...context, users: [{ id: "UCAROL", profile: { display_name: "Carol" } }] },
  });
  expect(conversations[0]?.diagnostics).toMatchObject([{ code: "slack_message_dropped" }]);
  expect(conversations[1]?.diagnostics).toEqual([]);
  expect(conversations[1]?.records[1]).toMatchObject({ speaker: { id: "UCAROL", name: "Carol" } });
  expect(normalizeConversations({ source: "slack", transcript: "[]", context })).toEqual({ conversations: [] });
  expect(() => normalizeConversations({ source: "slack", transcript: "{}", context })).toThrow("JSONL");
  expect(() => normalizeConversations({ source: "slack", transcript: "not json\n", context })).toThrow("line 1");
  expect(() => normalizeConversations({
    source: "slack", transcript: JSON.stringify([root]), context: { team: "T", channel: " " },
  })).toThrow("channel");
  expect(() => normalizeConversations({
    source: "slack", transcript: JSON.stringify({ ...context, thread_ts: root.ts, messages: [root] }), context,
  })).toThrow("JSONL");
});
