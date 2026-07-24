import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * pi sessions: `<agentDir>/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl`,
 * where the escaped cwd is the working directory with `/` replaced by `-`.
 * The agent directory defaults to `$PI_CODING_AGENT_DIR`, then `~/.pi/agent` —
 * mirroring pi's own resolution order.
 */
export async function listPiTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? defaultAgentDir();
  const items: TrajectoryListing[] = [];
  const sessionsPath = join(base, "sessions");
  for (const project of safeReadDir(sessionsPath)) {
    if (!project.isDirectory) continue;
    const projectPath = join(sessionsPath, project.name);
    for (const entry of safeReadDir(projectPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = join(projectPath, entry.name);
      const listing = listingFromFile(basename(entry.name, ".jsonl"), path);
      if (listing) items.push(listing);
    }
  }
  return sortListings(items);
}

function defaultAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}
