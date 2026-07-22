import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import {
  listingFromFile,
  safeReadDir,
  sortListings,
} from "../listing-shared.js";

/** Claude Code sessions: `~/.claude/projects/<project>/<sessionId>.jsonl`. */
export async function listClaudeCodeTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".claude", "projects");
  const items: TrajectoryListing[] = [];
  for (const project of safeReadDir(base)) {
    if (!project.isDirectory) continue;
    const projectPath = join(base, project.name);
    for (const entry of safeReadDir(projectPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = join(projectPath, entry.name);
      const listing = listingFromFile(basename(entry.name, ".jsonl"), path);
      if (listing) items.push(listing);
    }
  }
  return sortListings(items);
}
