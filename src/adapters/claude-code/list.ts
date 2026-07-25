import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import {
  collectFiles,
  listingFromFile,
  safeReadDir,
  sortListings,
} from "../listing-shared.js";

const AGENT_PREFIX = "agent-";
const JSONL_SUFFIX = ".jsonl";

/**
 * Claude Code parent sessions and standalone subagents under
 * `~/.claude/projects/<project>/`.
 */
export async function listClaudeCodeTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".claude", "projects");
  const items: TrajectoryListing[] = [];
  for (const project of safeReadDir(base)) {
    if (!project.isDirectory) continue;
    const projectPath = join(base, project.name);
    for (const entry of safeReadDir(projectPath)) {
      if (entry.isFile && entry.name.endsWith(JSONL_SUFFIX)) {
        const path = join(projectPath, entry.name);
        const listing = listingFromFile(
          agentIdFromFilename(entry.name) ??
            basename(entry.name, JSONL_SUFFIX),
          path,
        );
        if (listing) items.push(listing);
        continue;
      }
      if (!entry.isDirectory) continue;

      // Current Claude Code stores subagents directly under `subagents/`.
      // Dynamic workflows add `workflows/<runId>/` beneath that directory.
      // Restrict discovery to agent-named JSONL so orchestration journals and
      // any other JSONL sidecars do not become trajectories.
      const subagentsRoot = join(projectPath, entry.name, "subagents");
      for (const path of collectFiles(subagentsRoot, JSONL_SUFFIX, 2)) {
        const agentId = agentIdFromFilename(basename(path));
        if (!agentId) continue;
        const listing = listingFromFile(agentId, path);
        if (listing) items.push(listing);
      }
    }
  }
  return sortListings(items);
}

function agentIdFromFilename(filename: string): string | undefined {
  if (
    !filename.startsWith(AGENT_PREFIX) ||
    !filename.endsWith(JSONL_SUFFIX)
  ) {
    return undefined;
  }
  const agentId = filename.slice(AGENT_PREFIX.length, -JSONL_SUFFIX.length);
  return agentId || undefined;
}
