import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import {
  collectFiles,
  listingFromFile,
  sortListings,
} from "../listing-shared.js";

/**
 * Codex rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The date
 * nesting is walked recursively; the file stem is the listing id (the session
 * uuid inside `session_meta` requires reading the transcript).
 */
export async function listCodexTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".codex", "sessions");
  const items: TrajectoryListing[] = [];
  for (const path of collectFiles(base, ".jsonl", 4)) {
    const listing = listingFromFile(basename(path, ".jsonl"), path);
    if (listing) items.push(listing);
  }
  return sortListings(items);
}
