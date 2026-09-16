import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * Prime Agent sessions: `<agentDir>/sessions/<sessionId>.jsonl` (flat).
 * The agent directory defaults to `$PRIME_AGENT_CODING_AGENT_DIR`, then
 * `~/.prime/agent`. `$PRIME_AGENT_SESSION_DIR` /
 * `$PRIME_AGENT_CODING_AGENT_SESSION_DIR` relocate the sessions root.
 * Legacy per-cwd `sessions/--escaped--/*.jsonl` trees are not enumerated.
 */
export async function listPrimeTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const sessionsPath = root
    ? join(root, "sessions")
    : resolvePrimeSessionsPath({
        home: homedir(),
        env: process.env,
      });
  const items: TrajectoryListing[] = [];
  for (const entry of safeReadDir(sessionsPath)) {
    if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
    const path = join(sessionsPath, entry.name);
    const listing = listingFromFile(basename(entry.name, ".jsonl"), path);
    if (listing) items.push(listing);
  }
  return sortListings(items);
}

interface PrimePathEnvironment {
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Mirror Prime Agent's session-directory inputs. */
export function resolvePrimeSessionsPath(options: PrimePathEnvironment): string {
  const sessionOverride =
    options.env.PRIME_AGENT_SESSION_DIR?.trim() ||
    options.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionOverride) return sessionOverride;
  const agentOverride = options.env.PRIME_AGENT_CODING_AGENT_DIR?.trim();
  const agentDir = agentOverride || join(options.home, ".prime", "agent");
  return join(agentDir, "sessions");
}
