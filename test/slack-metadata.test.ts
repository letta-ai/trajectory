import { expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { normalizeConversation, validateConversation } from "../src/conversations/index.js";
import type { ConversationPost } from "../src/conversations/index.js";

const ts = "1700000000.000001";
const root = { type: "message", user: "UALICE", ts, text: ":eyes:" };
const reactions = [{ name: "nod", count: 5, users: ["UCAROL", "UBOB"] }];
const schema = new Ajv2020({ strictTuples: false }).compile(JSON.parse(readFileSync(
  new URL("../schema/conversation-v1.schema.json", import.meta.url), "utf8",
)));
function normalize(messages: unknown[], users?: unknown) {
  return normalizeConversation({
    source: "slack", transcript: JSON.stringify(messages), channel: "CEXAMPLE",
    // Some tests deliberately pass malformed user lists; the API rejects them at runtime.
    ...(users === undefined ? {} : { users: users as unknown[] }),
  });
}
function post(result: ReturnType<typeof normalize>): ConversationPost {
  const record = result.records[1];
  if (!record || !("speaker" in record)) throw new Error("Expected a post");
  return record;
}

test("resolves user display names without replacing source identity", () => {
  const result = normalize([root], [{
    id: "UALICE", name: "alice-handle", real_name: "Alice Example",
    profile: { display_name: "Alice", real_name: "Alice Example" },
  }]);
  expect(post(result).speaker).toEqual({ id: "UALICE", name: "Alice" });
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("uses real name then account name when display name is blank", () => {
  expect(post(normalize([root], [{ id: "UALICE", profile: { display_name: "  ", real_name: "Alice Example" } }])).speaker)
    .toEqual({ id: "UALICE", name: "Alice Example" });
  expect(post(normalize([root], [{ id: "UALICE", name: "alice-handle" }])).speaker)
    .toEqual({ id: "UALICE", name: "alice-handle" });
  expect(post(normalize([root])).speaker).toEqual({ id: "UALICE" });
});

test("inline profiles and bot profiles name the actual sender, not relayed people", () => {
  expect(post(normalize([{ ...root, user_profile: { display_name: "Alice" } }])).speaker)
    .toEqual({ id: "UALICE", name: "Alice" });
  expect(post(normalize([{ ...root, bot_id: "BBOT", bot_profile: { name: "Relay" }, text: "*User* Alice: hello" }])).speaker)
    .toEqual({ id: "UALICE", name: "Relay" });
  expect(post(normalize([{ ...root, user: undefined, bot_id: "BBOT", bot_profile: { name: "Relay" } }])).speaker)
    .toEqual({ id: "BBOT", name: "Relay" });
});

test("names resolve on replies too, from the same user list", () => {
  const reply = { ...root, ts: "1700000001.000001", thread_ts: ts, user: "UBOB", text: "hi" };
  const result = normalize([root, reply], [{ id: "UBOB", profile: { display_name: "Bob" } }]);
  expect(post(result).speaker).toEqual({ id: "UALICE" });
  expect(post(result).replies?.[0]?.speaker).toEqual({ id: "UBOB", name: "Bob" });
});

test("preserves authoritative counts with partial reactor lists and inline emoji text", () => {
  const result = normalize([{ ...root, reactions }]);
  expect<unknown>(post(result)).toMatchObject({
    content: ":eyes:",
    reactions: [{ name: "nod", count: 5, users: [{ id: "UBOB" }, { id: "UCAROL" }] }],
  });
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("reactors resolve names from the same user list as speakers", () => {
  const result = normalize([{ ...root, reactions }], [
    { id: "UBOB", profile: { display_name: "Bob" } },
    { id: "UALICE", real_name: "Alice Example" },
  ]);
  expect(post(result).speaker).toEqual({ id: "UALICE", name: "Alice Example" });
  expect(post(result).reactions).toEqual([
    { name: "nod", count: 5, users: [{ id: "UBOB", name: "Bob" }, { id: "UCAROL" }] },
  ]);
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("does not conflate missing reaction snapshots with observed empty snapshots", () => {
  expect(post(normalize([root]))).not.toHaveProperty("reactions");
  expect(post(normalize([{ ...root, reactions: [] }])).reactions).toEqual([]);
});

test("reaction and reactor ordering cannot create false snapshot conflicts", () => {
  const first = { ...root, reactions: [...reactions, { name: "eyes", count: 1, users: ["UBOB"] }] };
  const second = { ...root, reactions: [
    { name: "eyes", count: 1, users: ["UBOB"] },
    { name: "nod", count: 5, users: ["UBOB", "UCAROL"] },
  ] };
  expect(normalize([first, second])).toEqual(normalize([second, first]));
  expect(normalize([first, second]).records).toHaveLength(2);
});

test("changed reactions and names are conflicting snapshots, not silently discarded", () => {
  expect(() => normalize([{ ...root, reactions }, { ...root, reactions: [] }])).toThrow("Conflicting");
  expect(() => normalize([
    { ...root, user_profile: { display_name: "Alice" } },
    { ...root, user_profile: { display_name: "Different" } },
  ])).toThrow("Conflicting");
});

test("rejects malformed reactions and conflicting user directory rows", () => {
  for (const invalid of [null, {}, [{ name: "nod", count: -1, users: [] }],
    [{ name: "nod", count: 0.5, users: [] }], [{ name: "nod", count: 0, users: ["U1"] }],
    [{ name: "nod", count: 2, users: ["U1", "U1"] }], [{ name: "nod", count: 1, users: [42] }],
  ]) expect(() => normalize([{ ...root, reactions: invalid }])).toThrow();
  expect(() => normalize([root], {})).toThrow();
  expect(() => normalize([root], [
    { id: "UALICE", name: "Alice" }, { id: "UALICE", name: "Other" },
  ])).toThrow();
});

test("conversation schema validates optional names and reactions", () => {
  const result = normalize([root]);
  const record = post(result);
  for (const invalid of [
    { ...record, speaker: { id: "UALICE", name: 42 } },
    { ...record, speaker: { id: "UALICE", name: " " } },
    { ...record, reactions: null },
    { ...record, reactions: [{ name: "nod", count: 0.5, users: [] }] },
    { ...record, reactions: [{ name: "nod", count: -1, users: [] }] },
    { ...record, reactions: [{ name: "nod", count: 2, users: [{ id: "U1" }, { id: "U1" }] }] },
    { ...record, reactions: [{ name: "nod", count: 2, users: [{ id: 1 }] }] },
    { ...record, reactions: [{ name: "nod", count: 2, users: ["U1"] }] },
    { ...record, reactions: [{ name: "nod", count: 2, users: [{ id: "U1", name: " " }] }] },
    { ...record, reactions: [{ name: "nod", count: 2, users: [{ id: "U1", extra: true }] }] },
    { ...record, reactions: [{ name: "nod", count: Number.MAX_SAFE_INTEGER + 1, users: [] }] },
    { ...record, metadata: { reactions: [] } },
  ]) {
    const records = [result.records[0], invalid];
    expect(() => validateConversation(records)).toThrow();
    expect(schema(records)).toBe(false);
  }
  const duplicateNames = [{ name: "nod", count: 1, users: [] }, { name: "nod", count: 2, users: [] }];
  expect(() => normalize([{ ...root, reactions: duplicateNames }])).toThrow("unique");
});
