import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import {
  listingFromFile,
  safeReadDir,
  sortListings,
} from "../listing-shared.js";

const JSONL_SUFFIX = ".jsonl";

/**
 * Cursor parent sessions and standalone subagents under
 * `~/.cursor/projects/<slug>/agent-transcripts/<session-uuid>/`.
 */
export async function listCursorTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".cursor", "projects");
  const items: TrajectoryListing[] = [];
  for (const project of safeReadDir(base)) {
    if (!project.isDirectory) continue;
    const transcripts = join(base, project.name, "agent-transcripts");
    for (const session of safeReadDir(transcripts)) {
      if (!session.isDirectory) continue;
      const sessionDir = join(transcripts, session.name);
      const parent = listingFromFile(
        session.name,
        join(sessionDir, `${session.name}${JSONL_SUFFIX}`),
      );
      if (parent) items.push(parent);
      const subagentsDir = join(sessionDir, "subagents");
      for (const child of safeReadDir(subagentsDir)) {
        if (!child.isFile || !child.name.endsWith(JSONL_SUFFIX)) continue;
        const listing = listingFromFile(
          basename(child.name, JSONL_SUFFIX),
          join(subagentsDir, child.name),
        );
        if (listing) items.push(listing);
      }
    }
  }
  return sortListings(collapseNewestById(items));
}

/** The same uuid can appear under more than one project folder. */
function collapseNewestById(items: TrajectoryListing[]): TrajectoryListing[] {
  const newest = new Map<string, TrajectoryListing>();
  for (const item of items) {
    const current = newest.get(item.id);
    if (!current) {
      newest.set(item.id, item);
      continue;
    }
    const currentTime = current.updatedAt ?? "";
    const nextTime = item.updatedAt ?? "";
    if (nextTime > currentTime) newest.set(item.id, item);
  }
  return [...newest.values()];
}
