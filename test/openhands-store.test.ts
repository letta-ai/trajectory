import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenHandsConversationsPath } from "../src/adapters/openhands/list.js";
import { assembleOpenHandsEventFolder, normalizeTranscript } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("assembleOpenHandsEventFolder", () => {
  test("assembles event files by numeric index and ignores sidecars", () => {
    const eventsPath = makeEventDirectory();
    writeEvent(eventsPath, "event-100000-latest.json", {
      id: "latest",
      kind: "MessageEvent",
    });
    writeEvent(eventsPath, "event-99999-middle.json", {
      id: "middle",
      kind: "ActionEvent",
    });
    writeEvent(eventsPath, "event-00001-one.json", { id: "one", kind: "MessageEvent" });
    writeFileSync(join(eventsPath, ".eventlog-len-3.marker"), "");
    writeFileSync(join(eventsPath, ".eventlog.lock"), "");
    writeFileSync(join(eventsPath, "notes.json"), "not event data");

    const transcript = assembleOpenHandsEventFolder(eventsPath);

    expect(JSON.parse(transcript)).toEqual([
      { id: "one", kind: "MessageEvent" },
      { id: "middle", kind: "ActionEvent" },
      { id: "latest", kind: "MessageEvent" },
    ]);
  });

  test("returns an empty serialized array for an empty event directory", () => {
    expect(assembleOpenHandsEventFolder(makeEventDirectory())).toBe("[]");
  });

  test("produces a transcript accepted by the filesystem-free normalizer", () => {
    const eventsPath = makeEventDirectory();
    writeEvent(eventsPath, "event-00000-user.json", {
      kind: "MessageEvent",
      id: "user-message",
      timestamp: "2026-09-09T10:00:00Z",
      source: "user",
      llm_message: { content: [{ type: "text", text: "Hello." }] },
    });
    writeEvent(eventsPath, "event-00001-agent.json", {
      kind: "MessageEvent",
      id: "agent-message",
      timestamp: "2026-09-09T10:00:01Z",
      source: "agent",
      llm_message: { content: [{ type: "text", text: "Hi." }] },
    });

    const result = normalizeTranscript({
      source: "openhands",
      transcript: assembleOpenHandsEventFolder(eventsPath),
    });

    expect(result.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "assistant",
    ]);
  });

  test("fails clearly when the event directory cannot be read", () => {
    const root = makeTemporaryDirectory();
    const missing = join(root, "missing-events");

    expect(() => assembleOpenHandsEventFolder(missing)).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("Could not read OpenHands event directory"),
      }),
    );
  });

  test("fails clearly on malformed event filenames and documents", () => {
    const badFilenamePath = makeEventDirectory();
    writeEvent(badFilenamePath, "event-no-index.json", { id: "bad" });
    expect(() => assembleOpenHandsEventFolder(badFilenamePath)).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("expected a regular file named"),
      }),
    );

    const badJsonPath = makeEventDirectory();
    writeFileSync(join(badJsonPath, "event-00001-bad-json.json"), "{");
    expect(() => assembleOpenHandsEventFolder(badJsonPath)).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("Invalid JSON in OpenHands event file"),
      }),
    );

    const nonObjectPath = makeEventDirectory();
    writeFileSync(join(nonObjectPath, "event-00001-array.json"), "[]");
    expect(() => assembleOpenHandsEventFolder(nonObjectPath)).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("must contain one JSON object"),
      }),
    );
  });

  test("rejects duplicate numeric event indices", () => {
    const eventsPath = makeEventDirectory();
    writeEvent(eventsPath, "event-00001-first.json", { id: "first" });
    writeEvent(eventsPath, "event-000001-second.json", { id: "second" });

    expect(() => assembleOpenHandsEventFolder(eventsPath)).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("Duplicate OpenHands event index 1"),
      }),
    );
  });
});

describe("resolveOpenHandsConversationsPath", () => {
  test("uses the OpenHands CLI env precedence", () => {
    expect(resolveOpenHandsConversationsPath({}, "/home/tester")).toBe(
      "/home/tester/.openhands/conversations",
    );
    expect(
      resolveOpenHandsConversationsPath(
        { OPENHANDS_PERSISTENCE_DIR: "/var/lib/openhands" },
        "/home/tester",
      ),
    ).toBe("/var/lib/openhands/conversations");
    expect(
      resolveOpenHandsConversationsPath(
        {
          OPENHANDS_CONVERSATIONS_DIR: "/data/conversations",
          OPENHANDS_PERSISTENCE_DIR: "/ignored",
        },
        "/home/tester",
      ),
    ).toBe("/data/conversations");
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trajectory-openhands-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeEventDirectory(): string {
  const eventsPath = join(makeTemporaryDirectory(), "events");
  mkdirSync(eventsPath);
  return eventsPath;
}

function writeEvent(
  eventsPath: string,
  filename: string,
  event: Record<string, unknown>,
): void {
  writeFileSync(join(eventsPath, filename), JSON.stringify(event));
}
