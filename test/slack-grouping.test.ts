import { expect, test } from "bun:test";
import { groupSlackMessages, normalizeConversation } from "../src/conversations/index.js";

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
