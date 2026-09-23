import { expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { normalizeConversation, validateConversation } from "../src/conversations/index.js";

const ts = "1700000000.000001";
const root = { type: "message", user: "UALICE", ts, text: ":eyes:" };
const reactions = [{ name: "nod", count: 5, users: ["UCAROL", "UBOB"] }];
const schema = new Ajv2020({ strictTuples: false }).compile(JSON.parse(readFileSync(
  new URL("../schema/conversation-v1.schema.json", import.meta.url), "utf8",
)));
function normalize(messages: unknown[], users?: unknown) {
  return normalizeConversation({ source: "slack", transcript: JSON.stringify({
    team: "TEXAMPLE", channel: "CEXAMPLE", thread_ts: ts, messages, users,
  }) });
}

test("resolves user display names without replacing source identity", () => {
  const result = normalize([root], [{
    id: "UALICE", name: "alice-handle", real_name: "Alice Example",
    profile: { display_name: "Alice", real_name: "Alice Example" },
  }]);
  expect(result.records[1]?.speaker).toEqual({ id: "UALICE", name: "Alice" });
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("uses real name then account name when display name is blank", () => {
  expect(normalize([root], [{ id: "UALICE", profile: { display_name: "  ", real_name: "Alice Example" } }])
    .records[1]?.speaker).toEqual({ id: "UALICE", name: "Alice Example" });
  expect(normalize([root], [{ id: "UALICE", name: "alice-handle" }])
    .records[1]?.speaker).toEqual({ id: "UALICE", name: "alice-handle" });
  expect(normalize([root]).records[1]?.speaker).toEqual({ id: "UALICE" });
});

test("inline profiles and bot profiles name the actual sender, not relayed people", () => {
  expect(normalize([{ ...root, user_profile: { display_name: "Alice" } }]).records[1]?.speaker)
    .toEqual({ id: "UALICE", name: "Alice" });
  expect(normalize([{ ...root, bot_id: "BBOT", bot_profile: { name: "Relay" }, text: "*User* Alice: hello" }])
    .records[1]?.speaker).toEqual({ id: "UALICE", name: "Relay" });
  expect(normalize([{ ...root, user: undefined, bot_id: "BBOT", bot_profile: { name: "Relay" } }])
    .records[1]?.speaker).toEqual({ id: "BBOT", name: "Relay" });
});

test("preserves authoritative counts with partial reactor lists and inline emoji text", () => {
  const result = normalize([{ ...root, reactions }]);
  expect<unknown>(result.records[1]).toMatchObject({
    content: ":eyes:",
    metadata: { reactions: [{ name: "nod", count: 5, users: ["UBOB", "UCAROL"] }] },
  });
  validateConversation(result.records);
  expect(schema(result.records)).toBe(true);
});

test("does not conflate missing reaction snapshots with observed empty snapshots", () => {
  expect(normalize([root]).records[1]).not.toHaveProperty("metadata");
  expect<unknown>(normalize([{ ...root, reactions: [] }]).records[1])
    .toMatchObject({ metadata: { reactions: [] } });
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


test("conversation schema validates optional names and reaction metadata", () => {
  const result = normalize([root]);
  const record = result.records[1];
  if (!record) throw new Error("Expected message");
  for (const invalid of [
    { ...record, speaker: { id: "UALICE", name: 42 } },
    { ...record, speaker: { id: "UALICE", name: " " } },
    { ...record, metadata: null },
    { ...record, metadata: { reactions: null } },
    { ...record, metadata: { reactions: [{ name: "nod", count: 0.5, users: [] }] } },
    { ...record, metadata: { reactions: [{ name: "nod", count: -1, users: [] }] } },
    { ...record, metadata: { reactions: [{ name: "nod", count: 2, users: ["U1", "U1"] }] } },
    { ...record, metadata: { reactions: [{ name: "nod", count: 2, users: [1] }] } },
    { ...record, metadata: { reactions: [{ name: "nod", count: Number.MAX_SAFE_INTEGER + 1, users: [] }] } },
  ]) {
    const records = [result.records[0], invalid];
    expect(() => validateConversation(records)).toThrow();
    expect(schema(records)).toBe(false);
  }
  const duplicateNames = [{ name: "nod", count: 1, users: [] }, { name: "nod", count: 2, users: [] }];
  expect(() => normalize([{ ...root, reactions: duplicateNames }])).toThrow("unique");
});
