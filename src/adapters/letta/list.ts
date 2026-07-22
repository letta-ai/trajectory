import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * Letta local conversations:
 * `~/.letta/lc-local-backend/conversations/<dir>/messages.jsonl`, where the
 * directory name is base64 of the conversation id (for example
 * `conversation:local-conv-1`). Directories without a `messages.jsonl` (not
 * yet persisted) are skipped.
 */
export async function listLettaTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base =
    root ?? join(homedir(), ".letta", "lc-local-backend", "conversations");
  const items: TrajectoryListing[] = [];
  for (const entry of safeReadDir(base)) {
    if (!entry.isDirectory) continue;
    const path = join(base, entry.name, "messages.jsonl");
    const listing = listingFromFile(conversationId(entry.name), path);
    if (listing) items.push(listing);
  }
  return sortListings(items);
}

function conversationId(directoryName: string): string {
  try {
    const decoded = Buffer.from(directoryName, "base64").toString("utf8");
    // Round-trip check: a directory name that is not actually base64 decodes
    // to garbage; keep the literal name in that case.
    if (
      decoded &&
      Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") ===
        directoryName.replace(/=+$/, "")
    ) {
      return decoded;
    }
  } catch {
    // Fall through to the literal directory name.
  }
  return directoryName;
}
