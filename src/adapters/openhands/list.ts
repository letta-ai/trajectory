import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { safeReadDir, safeStat, sortListings } from "../listing-shared.js";

/**
 * OpenHands sessions: one directory per session under `~/.openhands/sessions`.
 * The listing's `path` is the session directory; assembling its event files
 * into the JSON event array remains the caller's responsibility, as for
 * normalization.
 */
export async function listOpenHandsTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".openhands", "sessions");
  const items: TrajectoryListing[] = [];
  for (const entry of safeReadDir(base)) {
    if (!entry.isDirectory) continue;
    const path = join(base, entry.name);
    const facts = safeStat(path);
    items.push({
      id: entry.name,
      path,
      ...(facts ? { updatedAt: new Date(facts.mtimeMs).toISOString() } : {}),
    });
  }
  return sortListings(items);
}
