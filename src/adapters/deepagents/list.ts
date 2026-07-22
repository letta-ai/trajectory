import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { openSqliteReadOnly, safeStat } from "../listing-shared.js";

/**
 * Deep Agents threads live in the `checkpoints` table of
 * `~/.deepagents/sessions.db` (root checkpoint namespace). LangGraph
 * checkpoint ids are time-ordered UUIDs, so threads are returned newest-first
 * by their latest checkpoint id; the store exposes no decoded timestamp
 * without reading checkpoint blobs, so `updatedAt` is omitted. Feed the id to
 * `normalizeCheckpoint` as `threadId`.
 */
export async function listDeepAgentsTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const path = resolveStorePath(root);
  if (!safeStat(path)) return [];
  const database = await openSqliteReadOnly(path);
  try {
    const rows = database.all(
      "SELECT thread_id, MAX(checkpoint_id) AS latest FROM checkpoints " +
        "WHERE checkpoint_ns = '' GROUP BY thread_id ORDER BY latest DESC, thread_id",
    );
    const items: TrajectoryListing[] = [];
    for (const row of rows) {
      if (typeof row.thread_id !== "string" || !row.thread_id) continue;
      items.push({ id: row.thread_id, path });
    }
    return items;
  } finally {
    database.close();
  }
}

function resolveStorePath(root: string | undefined): string {
  if (root === undefined) return join(homedir(), ".deepagents", "sessions.db");
  // Accept either the database file or the directory containing it.
  return root.endsWith(".db") ? root : join(root, "sessions.db");
}
