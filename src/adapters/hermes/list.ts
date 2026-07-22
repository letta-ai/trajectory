import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { openSqliteReadOnly, safeStat, sortListings } from "../listing-shared.js";

/**
 * Hermes sessions live in the `sessions` table of `~/.hermes/state.db`. The
 * listing id is the session id; `path` is the SQLite store — export the
 * session's message rows from it to obtain the transcript.
 */
export async function listHermesTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const path = resolveStorePath(root);
  if (!safeStat(path)) return [];
  const database = await openSqliteReadOnly(path);
  try {
    const rows = database.all(
      "SELECT id, title, started_at, ended_at FROM sessions",
    );
    const items: TrajectoryListing[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id) continue;
      const updated = numeric(row.ended_at) ?? numeric(row.started_at);
      items.push({
        id: row.id,
        path,
        ...(updated !== undefined
          ? { updatedAt: new Date(updated * 1_000).toISOString() }
          : {}),
        ...(typeof row.title === "string" && row.title
          ? { title: row.title }
          : {}),
      });
    }
    return sortListings(items);
  } finally {
    database.close();
  }
}

function resolveStorePath(root: string | undefined): string {
  if (root === undefined) return join(homedir(), ".hermes", "state.db");
  // Accept either the database file or the directory containing it.
  return root.endsWith(".db") ? root : join(root, "state.db");
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
