import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * OMP sessions: `<agentDir>/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl`,
 * where the escaped cwd encodes the working directory (home-relative `-<rel>`
 * with `/` replaced by `-`, or the legacy `--<abs>--` form). The agent
 * directory defaults to `$OMP_CODING_AGENT_DIR`, then the pi-compat
 * `$PI_CODING_AGENT_DIR`, then `~/.omp/agent` — mirroring OMP's own
 * resolution order.
 *
 * OMP additionally nests per-session subagent transcripts one level deeper
 * (`<timestamp>_<uuid>/<name>.jsonl`); those are not enumerated by this
 * lister, which mirrors the pi adapter and captures primary session
 * transcripts. Point `root` at a session subdirectory to enumerate nested
 * subagent transcripts.
 */
export async function listOmpTrajectories(
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
  const override =
    process.env.OMP_CODING_AGENT_DIR?.trim() ||
    process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".omp", "agent");
}
