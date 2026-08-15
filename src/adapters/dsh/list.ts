import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { collectFiles, listingFromFile, sortListings } from "../listing-shared.js";

/** List compressed DeepSeek Harness session logs without decompressing them. */
export async function listDshTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".dsh", "sessions");
  const items: TrajectoryListing[] = [];
  for (const path of collectFiles(base, ".jsonl.zstd", 4)) {
    const sessionDir = basename(join(path, ".."));
    const listing = listingFromFile(sessionDir, path);
    if (listing) items.push(listing);
  }
  return sortListings(items);
}
