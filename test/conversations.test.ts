import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { normalizeConversation, validateConversation } from "../src/conversations/index.js";
import { normalizeTranscript, normalizeToCanonical, validateTranscript } from "../src/index.js";

const schema = new Ajv2020({ strictTuples: false }).compile(JSON.parse(readFileSync(
  new URL("../schema/conversation-v1.schema.json", import.meta.url), "utf8",
)));
const message = {
  role: "message", id: "message-1", speaker: { id: "person-1" },
  content: "Can we ship today?", timestamp: "2026-09-22T12:00:00.000Z",
};
const meta = {
  role: "meta", source: "teams", conversation_id: "thread-1",
  source_metadata: { tenant: "tenant-1", channel: "channel-1" },
};

describe("independent conversation contract", () => {
  test("accepts source-native context without requiring Slack fields", () => {
    // Schema examples only: these are not implementations of other adapters.
    for (const source of ["teams", "gmail", "google-chat", "slack"]) {
      const records = [{ ...meta, source }, message];
      expect(() => validateConversation(records)).not.toThrow();
      expect(schema(records)).toBe(true);
    }
    const { source_metadata: _, ...minimalMeta } = meta;
    expect(() => validateConversation([minimalMeta, message])).not.toThrow();
  });

  test("requires shared metadata even for a reply-only fragment", () => {
    for (const invalid of [[], [meta], [message], [{ role: "meta", source: "slack" }, message]]) {
      expect(() => validateConversation(invalid)).toThrow();
      expect(schema(invalid)).toBe(false);
    }
  });

  test("rejects duplicate identities, malformed speakers, and unsupported message metadata", () => {
    expect(() => validateConversation([meta, message, message])).toThrow("unique");
    for (const invalid of [
      { ...message, id: " " },
      { ...message, speaker: {} },
      { ...message, speaker: { id: 1 } },
      { ...message, speaker: { id: "a", extra: true } },
      { ...message, content: " " },
      { ...message, timestamp: "bad" },
      { ...message, metadata: { reactions: [] } },
      { ...message, role: "assistant" },
    ]) {
      expect(() => validateConversation([meta, invalid])).toThrow();
      expect(schema([meta, invalid])).toBe(false);
    }
    for (const source_metadata of [null, [], { team: null }, { team: { nested: "value" } }]) {
      expect(() => validateConversation([{ ...meta, source_metadata }, message])).toThrow();
      expect(schema([{ ...meta, source_metadata }, message])).toBe(false);
    }
  });

  test("agent APIs reject Slack while the separate API accepts it", () => {
    const transcript = JSON.stringify({
      team: "T1", channel: "C1", thread_ts: "1700000000.000001",
      messages: [{ type: "message", user: "U1", ts: "1700000000.000001", text: "Hello" }],
    });
    const conversation = normalizeConversation({ source: "slack", transcript });
    expect(() => validateConversation(conversation.records)).not.toThrow();
    expect(() => validateTranscript(conversation.records)).toThrow();
    expect(() => normalizeTranscript({
      // @ts-expect-error Slack is deliberately not an agent trajectory source.
      source: "slack", transcript,
    })).toThrow();
    expect(() => normalizeToCanonical({
      // @ts-expect-error No agent canonical projection for imported conversations.
      source: "slack", transcript,
    })).toThrow();
  });

  test("real agent fixtures retain their original schema and are not conversations", () => {
    const transcript = readFileSync(new URL("../fixtures/atif/tool-calls/input.json", import.meta.url), "utf8");
    const result = normalizeTranscript({ source: "atif", transcript });
    const expected: unknown = JSON.parse(readFileSync(new URL("../fixtures/atif/tool-calls/expected.json", import.meta.url), "utf8"));
    expect<unknown>(result).toEqual(expected);
    expect(() => validateTranscript(result.records)).not.toThrow();
    expect(() => validateConversation(result.records)).toThrow();
    expect(schema(result.records)).toBe(false);
    expect(() => normalizeConversation({
      // @ts-expect-error Agent sources must use the agent API.
      source: "atif", transcript,
    })).toThrow();
  });
});
