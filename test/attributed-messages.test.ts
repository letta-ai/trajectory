import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { validateTranscript, type AttributedMessageRecord, type MetaRecord } from "../src/index.js";
import { normalizeDecodedSessionInternal } from "../src/core.js";
import { buildCanonicalRecords } from "../src/canonical.js";
import { resolveBounds } from "../src/bounds.js";

const schema = new Ajv2020().compile(JSON.parse(readFileSync(
  new URL("../schema/trajectory-v1.schema.json", import.meta.url), "utf8",
)));
const message: AttributedMessageRecord = {
  role: "message",
  id: "message-1",
  speaker: { id: "person-1" },
  content: "Can we ship today?",
  timestamp: "2026-09-22T12:00:00.000Z",
};
const meta = {
  role: "meta",
  source: "teams",
  conversation_id: "thread-1",
  source_metadata: { tenant: "tenant-1", channel: "channel-1" },
} satisfies MetaRecord;

describe("generic attributed conversation format", () => {
  test("accepts arbitrary source context without Slack-specific fields or roles", () => {
    // Schema examples, not claims that these source adapters are implemented.
    for (const source of ["teams", "gmail", "google-chat", "slack"]) {
      const records = [{ ...meta, source }, message];
      expect(() => validateTranscript(records)).not.toThrow();
      expect(schema(records)).toBe(true);
    }
  });

  test("thread metadata is optional except conversation identity", () => {
    const { source_metadata: _, ...minimalMeta } = meta;
    expect(() => validateTranscript([minimalMeta, message])).not.toThrow();
    expect(() => validateTranscript([{ role: "meta", source: "teams" }, message])).toThrow();
  });

  test("a partial fragment can omit shared metadata but not speaker identity", () => {
    expect(() => validateTranscript([message], { partial: true })).not.toThrow();
    expect(() => validateTranscript([message])).toThrow("meta");
    expect(() => validateTranscript([{ ...message, speaker: {} }], { partial: true })).toThrow();
  });

  test("normalization and canonical projection are not hardwired to Slack", () => {
    const project = (conversationId: string, sourceMetadata: Record<string, string>) => {
      const { timestamp, ...body } = message;
      const internal = normalizeDecodedSessionInternal({
        events: [{
          type: "attributed_message",
          message: body,
          timestamp: new Date(timestamp),
          sourceRecordId: body.id,
        }],
        context: { source: "teams", conversationId, sourceMetadata },
        diagnostics: [],
      }, resolveBounds(undefined));
      expect(internal.records).toEqual([
        { ...meta, conversation_id: conversationId, source_metadata: sourceMetadata },
        message,
      ]);
      return buildCanonicalRecords(internal, {
        groupId: "scope-1", baseByteOffset: 0, emitMeta: true,
      });
    };
    const before = project("thread-1", meta.source_metadata);
    const reordered = project("thread-1", { channel: "channel-1", tenant: "tenant-1" });
    expect(reordered).toEqual(before);
    expect(before[1]?.record_type).toBe("message");
    expect(before[1]?.source_type).toBe("teams");
    expect(before[1]?.record_json).toContain('"speaker":{"id":"person-1"}');
    expect(project("thread-2", meta.source_metadata)[0]?.content_hash).not.toBe(before[0]?.content_hash);
    expect(project("thread-1", { tenant: "tenant-2" })[0]?.content_hash).not.toBe(before[0]?.content_hash);
  });

  test("requires unique message IDs and identified speakers", () => {
    expect(() => validateTranscript([meta, message, message])).toThrow();
    for (const invalid of [
      { ...message, id: "" },
      { ...message, speaker: {} },
      { ...message, speaker: { id: 1 } },
      { ...message, metadata: { reactions: [] } },
    ]) {
      expect(() => validateTranscript([meta, invalid])).toThrow();
      expect(schema([meta, invalid])).toBe(false);
    }
  });

  test("does not relax existing agent requirements or mix attributed/agent roles", () => {
    const user = { role: "user", content: "Hello", timestamp: message.timestamp };
    expect(() => validateTranscript([{ role: "meta", source: "codex" }, user])).toThrow("assistant");
    expect(() => validateTranscript([meta, message, user])).toThrow();
  });

  test("checks metadata structure even when attached to an agent trajectory", () => {
    const body = [
      { role: "user", content: "Hello", timestamp: message.timestamp },
      { role: "assistant", content: "Hi", timestamp: message.timestamp },
    ];
    expect(() => validateTranscript([meta, ...body])).not.toThrow();
    for (const source_metadata of [null, [], { team: null }, { team: { nested: "value" } }]) {
      expect(() => validateTranscript([{ ...meta, source_metadata }, ...body])).toThrow();
      expect(schema([{ ...meta, source_metadata }, ...body])).toBe(false);
    }
  });
});
