import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * Letta Code client transcripts:
 * `~/.letta/transcripts/<agentId>/<conversationId>/transcript.jsonl`.
 * Empty logs are skipped because they cannot form a trajectory.
 */
export async function listLettaCodeTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? join(homedir(), ".letta", "transcripts");
  const items: TrajectoryListing[] = [];
  for (const agent of safeReadDir(base)) {
    if (!agent.isDirectory) continue;
    const agentPath = join(base, agent.name);
    for (const conversation of safeReadDir(agentPath)) {
      if (!conversation.isDirectory) continue;
      const path = join(agentPath, conversation.name, "transcript.jsonl");
      const listing = listingFromFile(
        `${agent.name}/${conversation.name}`,
        path,
      );
      if (listing && (listing.sizeBytes ?? 0) > 0) items.push(listing);
    }
  }
  return sortListings(items);
}
