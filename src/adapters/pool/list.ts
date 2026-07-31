import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { collectFiles, listingFromFile, sortListings } from "../listing-shared.js";

const TRAJECTORIES_DIR = "trajectories";
const FILE_PREFIX = "trajectory-standalone_";
const FILE_SUFFIX = ".ndjson";

/**
 * List Pool sessions from `~/.local/state/poolside/trajectories/`
 * (or `root`), newest first. Each session is one
 * `trajectory-standalone_<session-id>.ndjson` file. The session id is the
 * UUID parsed from the filename; the listing `path` is the transcript file
 * to read and pass to `normalizeTranscript({ source: "pool" })`.
 */
export async function listPoolTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const stateDir = root ?? join(homedir(), ".local", "state", "poolside");
  const base = join(stateDir, TRAJECTORIES_DIR);
  const items: TrajectoryListing[] = [];
  for (const path of collectFiles(base, FILE_SUFFIX, 0)) {
    const id = sessionIdFromFilename(path.split("/").pop()!);
    if (!id) continue;
    const listing = listingFromFile(id, path);
    if (listing) items.push(listing);
  }
  return sortListings(items);
}

function sessionIdFromFilename(filename: string): string | undefined {
  if (!filename.startsWith(FILE_PREFIX) || !filename.endsWith(FILE_SUFFIX)) {
    return undefined;
  }
  const id = filename.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
  return id || undefined;
}
