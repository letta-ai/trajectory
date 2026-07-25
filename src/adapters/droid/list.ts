import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import {
  collectFiles,
  listingFromFile,
  sortListings,
} from "../listing-shared.js";

/** List Droid JSONL sessions without involving the normalization adapter. */
export async function listDroidTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".factory", "sessions");
  const items: TrajectoryListing[] = [];
  // Droid nests sessions below cwd-derived directories, whose depth varies.
  for (const path of collectFiles(base, ".jsonl", 12)) {
    const listing = listingFromFile(basename(path, ".jsonl"), path);
    if (listing) items.push(listing);
  }
  return sortListings(items);
}
