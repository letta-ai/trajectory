import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOmpSessionsPath } from "../src/adapters/omp/list.js";
import { listTrajectories } from "../src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "trajectory-listing-"));

  // claude-code: two projects, three sessions with distinct mtimes.
  for (const [project, session, at] of [
    ["proj-a", "s-old", "2026-07-01T10:00:00Z"],
    ["proj-a", "s-new", "2026-07-03T10:00:00Z"],
    ["proj-b", "s-mid", "2026-07-02T10:00:00Z"],
  ] as const) {
    const dir = join(base, "claude", project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${session}.jsonl`);
    writeFileSync(file, `{"type":"user"}\n`);
    const time = new Date(at);
    utimesSync(file, time, time);
  }

  // claude-code standalone subagents: current direct/workflow layouts plus the
  // legacy project-level agent-file layout.
  for (const [relativePath, at] of [
    ["proj-a/s-new/subagents/agent-direct.jsonl", "2026-07-05T10:00:00Z"],
    [
      "proj-a/s-new/subagents/workflows/wf-1/agent-workflow.jsonl",
      "2026-07-06T10:00:00Z",
    ],
    ["proj-a/agent-legacy.jsonl", "2026-07-04T10:00:00Z"],
  ] as const) {
    const file = join(base, "claude", relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `{"type":"user","isSidechain":true}\n`);
    const time = new Date(at);
    utimesSync(file, time, time);
  }
  const workflowRoot = join(
    base,
    "claude",
    "proj-a",
    "s-new",
    "subagents",
    "workflows",
    "wf-1",
  );
  writeFileSync(join(workflowRoot, "journal.jsonl"), `{"type":"started"}\n`);
  writeFileSync(join(workflowRoot, "agent-workflow.meta.json"), "{}\n");
  writeFileSync(join(workflowRoot, "other.jsonl"), "{}\n");

  // codex: date-nested rollouts.
  for (const [day, name, at] of [
    ["2026/07/01", "rollout-a", "2026-07-01T09:00:00Z"],
    ["2026/07/02", "rollout-b", "2026-07-02T09:00:00Z"],
  ] as const) {
    const dir = join(base, "codex", day);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.jsonl`);
    writeFileSync(file, `{"type":"session_meta"}\n`);
    const time = new Date(at);
    utimesSync(file, time, time);
  }

  // letta-code: agent/conversation transcript logs; empty logs are skipped.
  const lettaCode = join(base, "letta-code", "agent-1");
  mkdirSync(join(lettaCode, "conversation-1"), { recursive: true });
  writeFileSync(
    join(lettaCode, "conversation-1", "transcript.jsonl"),
    '{"kind":"user"}\n',
  );
  mkdirSync(join(lettaCode, "empty-conversation"), { recursive: true });
  writeFileSync(join(lettaCode, "empty-conversation", "transcript.jsonl"), "");

  // openclaw: agents/<id>/sessions layout.
  const openclawSessions = join(base, "openclaw", "agents", "main", "sessions");
  mkdirSync(openclawSessions, { recursive: true });
  writeFileSync(join(openclawSessions, "oc-1.jsonl"), `{"type":"session"}\n`);
  writeFileSync(join(openclawSessions, "sessions.json"), "{}\n");

  // pi: <agentDir>/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl layout.
  const piSessions = join(base, "pi", "sessions", "-home-user-pi-demo--");
  mkdirSync(piSessions, { recursive: true });
  writeFileSync(
    join(piSessions, "2026-07-24T06-21-03-508Z_019f92c8.jsonl"),
    `{"type":"session"}\n`,
  );
  writeFileSync(join(base, "pi", "sessions", "stray.jsonl"), `{"type":"session"}\n`);
  // omp: <agentDir>/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl layout.
  // OMP is a pi-mono fork; primary session transcripts sit one level deep,
  // mirroring pi. Nested per-session subagent transcripts are not enumerated.
  const ompSessions = join(base, "omp", "sessions", "-home-user-omp-demo--");
  mkdirSync(ompSessions, { recursive: true });
  writeFileSync(
    join(ompSessions, "2026-07-24T06-21-03-508Z_019f92c8.jsonl"),
    `{"type":"session"}\n`,
  );

  // openhands: one directory per session.
  mkdirSync(join(base, "openhands", "sess-1"), { recursive: true });
  mkdirSync(join(base, "openhands", "sess-2"), { recursive: true });

  // hermes: a sessions table matching the state.db schema subset we read.
  // WAL mode mirrors live agent stores and exercises the read-only fallback.
  const hermes = new Database(join(base, "state.db"));
  hermes.run("PRAGMA journal_mode=WAL");
  hermes.run(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL, ended_at REAL)",
  );
  hermes.run(
    "INSERT INTO sessions VALUES ('h-old', 'first session', 1783000000.0, NULL)," +
      "('h-new', NULL, 1783100000.0, 1783100500.0)",
  );
  hermes.close();

  // cursor: parents + subagents, plus a duplicate id across project folders.
  for (const [relativePath, at] of [
    [
      "slug-old/agent-transcripts/parent-aaa/parent-aaa.jsonl",
      "2026-07-01T10:00:00Z",
    ],
    [
      "slug-old/agent-transcripts/parent-aaa/subagents/child-bbb.jsonl",
      "2026-07-02T10:00:00Z",
    ],
    [
      "slug-new/agent-transcripts/parent-aaa/parent-aaa.jsonl",
      "2026-07-04T10:00:00Z",
    ],
    [
      "slug-new/agent-transcripts/parent-ccc/parent-ccc.jsonl",
      "2026-07-03T10:00:00Z",
    ],
    [
      "slug-new/agent-transcripts/parent-ccc/subagents/child-ddd.jsonl",
      "2026-07-05T10:00:00Z",
    ],
  ] as const) {
    const file = join(base, "cursor", relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `{"role":"user","message":{"content":"hi"}}\n`);
    const time = new Date(at);
    utimesSync(file, time, time);
  }
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("listTrajectories", () => {
  test("reports normalization-only sources without pretending to discover a store", async () => {
    for (const source of [
      "copilot-cli",
      "gemini-cli",
      "opencode",
    ] as const) {
      await expect(listTrajectories({ source })).rejects.toEqual(
        expect.objectContaining({ code: "listing_unavailable" }),
      );
    }
  });

  test("lists cursor parents and subagents and collapses duplicate ids to newest", async () => {
    const result = await listTrajectories({
      source: "cursor",
      root: join(base, "cursor"),
    });
    expect(result.items.map((item) => item.id)).toEqual([
      "child-ddd",
      "parent-aaa",
      "parent-ccc",
      "child-bbb",
    ]);
    expect(result.items[1]?.path.includes("slug-new")).toBe(true);
    expect(result.items[1]?.updatedAt).toBe("2026-07-04T10:00:00.000Z");
    expect(result.items.some((item) => item.path.includes("subagents"))).toBe(
      true,
    );
  });

  test("lists claude-code parent and subagent sessions newest first", async () => {
    const result = await listTrajectories({
      source: "claude-code",
      root: join(base, "claude"),
    });
    expect(result.items.map((item) => item.id)).toEqual([
      "workflow",
      "direct",
      "legacy",
      "s-new",
      "s-mid",
      "s-old",
    ]);
    expect(result.nextCursor).toBeUndefined();
    expect(result.items[0]?.path.endsWith("agent-workflow.jsonl")).toBe(true);
    expect(result.items[0]?.sizeBytes).toBeGreaterThan(0);
    expect(result.items[0]?.updatedAt).toBe("2026-07-06T10:00:00.000Z");
  });

  test("paginates with a cursor until exhaustion", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listTrajectories({
        source: "claude-code",
        root: join(base, "claude"),
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([
      "workflow",
      "direct",
      "legacy",
      "s-new",
      "s-mid",
      "s-old",
    ]);
    expect(pages).toBe(6);
  });

  test("lists codex rollouts across date directories", async () => {
    const result = await listTrajectories({ source: "codex", root: join(base, "codex") });
    expect(result.items.map((item) => item.id)).toEqual(["rollout-b", "rollout-a"]);
  });

  test("lists nonempty Letta Code client transcripts", async () => {
    const result = await listTrajectories({
      source: "letta-code",
      root: join(base, "letta-code"),
    });
    expect(result.items.map((item) => item.id)).toEqual([
      "agent-1/conversation-1",
    ]);
    expect(result.items[0]?.path.endsWith("transcript.jsonl")).toBe(true);
  });

  test("lists openclaw sessions and ignores the session store file", async () => {
    const result = await listTrajectories({
      source: "openclaw",
      root: join(base, "openclaw"),
    });
    expect(result.items.map((item) => item.id)).toEqual(["oc-1"]);
  });

  test("lists pi sessions and ignores files outside project directories", async () => {
    const result = await listTrajectories({
      source: "pi",
      root: join(base, "pi"),
    });
    expect(result.items.map((item) => item.id)).toEqual([
      "2026-07-24T06-21-03-508Z_019f92c8",
    ]);
    expect(result.items[0]?.path.endsWith(".jsonl")).toBe(true);
  });
  test("lists omp sessions and ignores files outside project directories", async () => {
    const result = await listTrajectories({
      source: "omp",
      root: join(base, "omp"),
    });
    expect(result.items.map((item) => item.id)).toEqual([
      "2026-07-24T06-21-03-508Z_019f92c8",
    ]);
    expect(result.items[0]?.path.endsWith(".jsonl")).toBe(true);
  });

  test("lists openhands session directories", async () => {
    const result = await listTrajectories({
      source: "openhands",
      root: join(base, "openhands"),
    });
    expect(result.items.map((item) => item.id).sort()).toEqual(["sess-1", "sess-2"]);
  });

  test("lists hermes sessions from the SQLite store with titles", async () => {
    const result = await listTrajectories({ source: "hermes", root: base });
    expect(result.items.map((item) => item.id)).toEqual(["h-new", "h-old"]);
    expect(result.items[1]?.title).toBe("first session");
    expect(result.items[0]?.updatedAt).toBe(
      new Date(1783100500.0 * 1_000).toISOString(),
    );
    expect(result.items[0]?.path.endsWith("state.db")).toBe(true);
  });

  test("lists deepagents threads from the fixture store", async () => {
    const result = await listTrajectories({
      source: "deepagents",
      root: join(ROOT, "fixtures", "deepagents", "checkpoint.db"),
    });
    expect(result.items.map((item) => item.id).sort()).toEqual([
      "thread-123",
      "thread-basic",
      "thread-overwrite",
    ]);
    // Newest-first by latest time-ordered checkpoint id.
    expect(result.items[0]?.id).toBe("thread-overwrite");
  });

  test("returns an empty listing for a missing store", async () => {
    for (const source of ["claude-code", "cursor", "hermes", "deepagents"] as const) {
      const result = await listTrajectories({
        source,
        root: join(base, "does-not-exist"),
      });
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeUndefined();
    }
  });

  test("rejects an invalid cursor, limit, and source", async () => {
    await expect(
      listTrajectories({
        source: "claude-code",
        root: join(base, "claude"),
        cursor: "not-a-cursor!",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    await expect(
      listTrajectories({ source: "claude-code", limit: 0 }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    await expect(
      listTrajectories({ source: "langsmith" as never }),
    ).rejects.toEqual(expect.objectContaining({ code: "unknown_source" }));
  });

  test("pagination degrades positionally when the cursor item vanishes", async () => {
    const first = await listTrajectories({
      source: "claude-code",
      root: join(base, "claude"),
      limit: 1,
    });
    expect(first.nextCursor).toBeDefined();
    // Same cursor against a different (single-project) root: the cursor id is
    // absent, so listing resumes from the recorded position instead of failing.
    const resumed = await listTrajectories({
      source: "codex",
      root: join(base, "codex"),
      cursor: first.nextCursor!,
      limit: 10,
    });
    expect(resumed.items.map((item) => item.id)).toEqual(["rollout-a"]);
  });
});

describe("OMP default store resolution", () => {
  const resolve = (
    env: NodeJS.ProcessEnv,
    existing: string[] = [],
    platform: NodeJS.Platform = "linux",
  ) =>
    resolveOmpSessionsPath({
      home: "/home/tester",
      platform,
      env,
      exists: (path) => existing.includes(path),
    });

  test("uses the supported default-profile overrides", () => {
    expect(resolve({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe(
      "/custom/agent/sessions",
    );
    expect(resolve({ PI_CONFIG_DIR: ".config/omp" })).toBe(
      "/home/tester/.config/omp/agent/sessions",
    );
  });

  test("resolves named profiles and OMP_PROFILE precedence", () => {
    expect(resolve({ PI_PROFILE: "legacy" })).toBe(
      "/home/tester/.omp/profiles/legacy/agent/sessions",
    );
    expect(
      resolve({
        OMP_PROFILE: "work",
        PI_PROFILE: "legacy",
        PI_CODING_AGENT_DIR: "/ignored/for/profiles",
      }),
    ).toBe("/home/tester/.omp/profiles/work/agent/sessions");
  });

  test("uses an initialized XDG data root and otherwise stays home-based", () => {
    expect(
      resolve(
        { XDG_DATA_HOME: "/xdg/data" },
        ["/xdg/data/omp"],
      ),
    ).toBe("/xdg/data/omp/sessions");
    expect(resolve({ XDG_DATA_HOME: "/xdg/data" })).toBe(
      "/home/tester/.omp/agent/sessions",
    );
    expect(
      resolve(
        { OMP_PROFILE: "work", XDG_DATA_HOME: "/xdg/data" },
        ["/xdg/data/omp/profiles/work"],
      ),
    ).toBe("/xdg/data/omp/profiles/work/sessions");
  });
});
