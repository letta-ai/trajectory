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
  expect(post(result).speaker).toBe("Alice");
  expect(result.records[0].participants).toEqual({ Alice: { id: "UALICE" } });
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("uses real name then account name when display name is blank", () => {
  expect(post(normalize([root], [{ id: "UALICE", profile: { display_name: "  ", real_name: "Alice Example" } }])).speaker)
    .toBe("Alice Example");
  expect(post(normalize([root], [{ id: "UALICE", name: "alice-handle" }])).speaker).toBe("alice-handle");
  expect(post(normalize([root])).speaker).toBe("UALICE");
});

test("inline profiles and bot profiles name the actual sender, not relayed people", () => {
  expect(post(normalize([{ ...root, user_profile: { display_name: "Alice" } }])).speaker).toBe("Alice");
  const relay = normalize([{ ...root, bot_id: "BBOT", bot_profile: { name: "Relay" }, text: "*User* Alice: hello" }]);
  expect(post(relay).speaker).toBe("Relay");
  expect(relay.records[0].participants).toEqual({ Relay: { id: "UALICE", bot: true } });
  const botOnly = normalize([{ ...root, user: undefined, bot_id: "BBOT", bot_profile: { name: "Relay" } }]);
  expect(botOnly.records[0].participants).toEqual({ Relay: { id: "BBOT", bot: true } });
});

test("the user list outranks names carried on messages", () => {
  const result = normalize([{ ...root, user_profile: { display_name: "Old Name" } }], [
    { id: "UALICE", profile: { display_name: "Alice" } },
  ]);
  expect(post(result).speaker).toBe("Alice");
});

test("without a user list, the most recent inline name labels every message from that sender", () => {
  const later = { ...root, ts: "1700000005.000001", text: "later", user_profile: { display_name: "New Name" } };
  const earlier = { ...root, user_profile: { display_name: "Old Name" } };
  const result = normalize([later, earlier]);
  expect(result.records.slice(1).map((r) => ("speaker" in r ? r.speaker : undefined))).toEqual(["New Name", "New Name"]);
  expect(normalize([earlier, later])).toEqual(result);
});

test("names resolve on replies too, from the same user list", () => {
  const reply = { ...root, ts: "1700000001.000001", thread_ts: ts, user: "UBOB", text: "hi" };
  const result = normalize([root, reply], [{ id: "UBOB", profile: { display_name: "Bob" } }]);
  expect(post(result).speaker).toBe("UALICE");
  expect(post(result).replies?.[0]?.speaker).toBe("Bob");
});

test("reactions keep names and source-reported counts, not reactors", () => {
  const result = normalize([{ ...root, reactions: [...reactions, { name: "eyes", count: 1, users: ["UBOB"] }] }]);
  expect(post(result)).toMatchObject({ content: ":eyes:", reactions: { eyes: 1, nod: 5 } });
  expect(Object.keys(post(result).reactions ?? {})).toEqual(["eyes", "nod"]);
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("does not conflate missing reaction snapshots with observed empty snapshots", () => {
  expect(post(normalize([root]))).not.toHaveProperty("reactions");
  expect(post(normalize([{ ...root, reactions: [] }])).reactions).toEqual({});
});

test("reaction and reactor ordering cannot create false snapshot conflicts", () => {
  const first = { ...root, reactions: [...reactions, { name: "eyes", count: 1, users: ["UBOB"] }] };
  const second = { ...root, reactions: [
    { name: "eyes", count: 1, users: ["UBOB"] },
    { name: "nod", count: 5, users: ["UBOB", "UCAROL"] },
  ] };
  expect(normalize([first, second])).toEqual(normalize([second, first]));
  expect(normalize([first, second]).diagnostics).toMatchObject([{ code: "slack_duplicate_message" }]);
});

test("rejects malformed reactions and conflicting user directory rows", () => {
  for (const invalid of [null, {}, [{ name: "nod", count: -1 }], [{ name: "nod", count: 0.5 }],
    [{ count: 1 }], [{ name: " ", count: 1 }], [{ name: "nod", count: 1 }, { name: "nod", count: 2 }],
  ]) expect(() => normalize([{ ...root, reactions: invalid }])).toThrow();
  expect(() => normalize([root], {})).toThrow();
  expect(() => normalize([root], [
    { id: "UALICE", name: "Alice" }, { id: "UALICE", name: "Other" },
  ])).toThrow();
});

test("conversation schema validates participants and reaction counts", () => {
  const result = normalize([root]);
  const [meta] = result.records;
  const record = post(result);
  for (const [invalidMeta, invalid] of [
    [meta, { ...record, speaker: { id: "UALICE" } }],
    [meta, { ...record, speaker: " " }],
    [meta, { ...record, reactions: null }],
    [meta, { ...record, reactions: [{ name: "nod", count: 1 }] }],
    [meta, { ...record, reactions: { nod: 0.5 } }],
    [meta, { ...record, reactions: { nod: -1 } }],
    [meta, { ...record, reactions: { nod: Number.MAX_SAFE_INTEGER + 1 } }],
    [meta, { ...record, reactions: { " ": 1 } }],
    [meta, { ...record, metadata: { reactions: {} } }],
    [{ ...meta, participants: undefined }, record],
    [{ ...meta, participants: { UALICE: { id: "UALICE", bot: false } } }, record],
    [{ ...meta, participants: { UALICE: { id: "UALICE", name: "Alice" } } }, record],
    [{ ...meta, participants: { UALICE: { id: " " } } }, record],
    [{ ...meta, channel_name: " " }, record],
  ]) {
    const records = [invalidMeta, invalid];
    expect(() => validateConversation(records)).toThrow();
    expect(schema(records)).toBe(false);
  }
  // Cross-references that JSON Schema cannot express.
  for (const records of [
    [meta, { ...record, speaker: "Nobody" }],
    [{ ...meta, participants: { A: { id: "U1" }, B: { id: "U1" } } }, { ...record, speaker: "A" }],
  ]) {
    expect(() => validateConversation(records)).toThrow();
    expect(schema(records)).toBe(true);
  }
});
