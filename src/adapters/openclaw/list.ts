import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * OpenClaw sessions: `<state>/agents/<agentId>/sessions/<sessionId>.jsonl`.
 * The state directory defaults to `$OPENCLAW_STATE_DIR` /
 * `$CLAWDBOT_STATE_DIR`, then `~/.openclaw`, then the legacy `~/.clawdbot` —
 * mirroring OpenClaw's own resolution order.
 */
export async function listOpenClawTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? defaultStateDir();
  const items: TrajectoryListing[] = [];
  const agentsPath = join(base, "agents");
  for (const agent of safeReadDir(agentsPath)) {
    if (!agent.isDirectory) continue;
    const sessionsPath = join(agentsPath, agent.name, "sessions");
    for (const entry of safeReadDir(sessionsPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = join(sessionsPath, entry.name);
      const listing = listingFromFile(basename(entry.name, ".jsonl"), path);
      if (listing) items.push(listing);
    }
  }
  return sortListings(items);
}

function defaultStateDir(): string {
  const override =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  const current = join(homedir(), ".openclaw");
  if (existsSync(current)) return current;
  return join(homedir(), ".clawdbot");
}
