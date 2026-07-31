/**
 * Ingest all local Pool (poolside) sessions into canonical trajectory records.
 *
 * Run from the repo root: `bun run scripts/ingest-pool.ts`
 *
 * Lists every `trajectory-standalone_<session-id>.ndjson` in
 * `~/.local/state/poolside/trajectories/` (newest first), normalizes each to
 * canonical records, and writes one `<session-id>.canonical.jsonl` per session
 * to `out/`. Records are the ingestion-ready contract documented in
 * CANONICAL.md — the input to the Cloud normalizer worker.
 *
 * Pool resolves its source group natively from the `session.start` event, so no
 * `sourceContext` is required for a complete session file. Use `sourceContext`
 * for partial/chunked uploads.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listTrajectories, normalizeToCanonical } from "../src/index.js";

const OUT_DIR = join(import.meta.dirname, "..", "out");

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await listTrajectories({
      source: "pool",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      const transcript = await Bun.file(item.path).text();
      const { records, diagnostics } = normalizeToCanonical({
        source: "pool",
        transcript,
      });
      const dest = join(OUT_DIR, `${item.id}.canonical.jsonl`);
      for (const record of records) {
        writeFileSync(dest, JSON.stringify(record) + "\n", { flag: "a" });
      }
      total += records.length;
      if (diagnostics.length) {
        console.log(`${item.id}: ${diagnostics.length} diagnostics`, diagnostics);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  console.log(`wrote ${total} canonical records to ${OUT_DIR}/`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});