import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { NormalizationError } from "../../types.js";
import { safeReadDir, safeStat, sortListings } from "../listing-shared.js";

const EVENT_FILE_PREFIX = "event-";
const EVENT_FILE_SUFFIX = ".json";
const EVENT_FILE_PATTERN = /^event-(\d{5,})-(.+)\.json$/u;

interface IndexedEventFile {
  name: string;
  index: bigint;
}

/**
 * OpenHands conversations: one directory per conversation under
 * `~/.openhands/conversations`. Only directories containing an `events/`
 * directory are trajectories; the listing's `path` is that event directory.
 */
export async function listOpenHandsTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const base = root ?? resolveOpenHandsConversationsPath();
  const items: TrajectoryListing[] = [];
  for (const entry of safeReadDir(base)) {
    if (!entry.isDirectory) continue;
    const conversationPath = join(base, entry.name);
    const hasEventsDirectory = safeReadDir(conversationPath).some(
      (child) => child.name === "events" && child.isDirectory,
    );
    if (!hasEventsDirectory) continue;
    const eventsPath = join(conversationPath, "events");
    const facts = safeStat(eventsPath);
    items.push({
      id: entry.name,
      path: eventsPath,
      ...(facts ? { updatedAt: new Date(facts.mtimeMs).toISOString() } : {}),
    });
  }
  return sortListings(items);
}

/**
 * Read an OpenHands `events/` directory into the serialized JSON array accepted
 * by `normalizeTranscript()`. Event files are ordered by the numeric index in
 * `event-<index>-<event-id>.json`; event-log markers and other sidecars are
 * ignored.
 */
export function assembleOpenHandsEventFolder(eventsPath: string): string {
  let entries: Dirent[];
  try {
    entries = readdirSync(eventsPath, { withFileTypes: true });
  } catch (error) {
    throw invalidEventFolder(
      `Could not read OpenHands event directory ${JSON.stringify(eventsPath)}: ${errorMessage(error)}`,
    );
  }

  const eventFiles: IndexedEventFile[] = [];
  for (const entry of entries) {
    if (
      !entry.name.startsWith(EVENT_FILE_PREFIX) ||
      !entry.name.endsWith(EVENT_FILE_SUFFIX)
    ) {
      continue;
    }
    const match = EVENT_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) {
      throw invalidEventFolder(
        `Invalid OpenHands event file ${JSON.stringify(join(eventsPath, entry.name))}: expected a regular file named event-<index with 5+ digits>-<event-id>.json.`,
      );
    }
    eventFiles.push({ name: entry.name, index: BigInt(match[1]!) });
  }

  eventFiles.sort((left, right) => {
    if (left.index !== right.index) return left.index < right.index ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  for (let index = 1; index < eventFiles.length; index += 1) {
    const previous = eventFiles[index - 1];
    const current = eventFiles[index];
    if (previous && current && previous.index === current.index) {
      throw invalidEventFolder(
        `Duplicate OpenHands event index ${current.index} in ${JSON.stringify(eventsPath)} (${JSON.stringify(previous.name)} and ${JSON.stringify(current.name)}).`,
      );
    }
  }

  const events: Record<string, unknown>[] = [];
  for (const eventFile of eventFiles) {
    const eventPath = join(eventsPath, eventFile.name);
    let contents: string;
    try {
      contents = readFileSync(eventPath, "utf8");
    } catch (error) {
      throw invalidEventFolder(
        `Could not read OpenHands event file ${JSON.stringify(eventPath)}: ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw invalidEventFolder(
        `Invalid JSON in OpenHands event file ${JSON.stringify(eventPath)}: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(parsed)) {
      throw invalidEventFolder(
        `OpenHands event file ${JSON.stringify(eventPath)} must contain one JSON object.`,
      );
    }
    events.push(parsed);
  }

  return JSON.stringify(events);
}

/** Resolve the native OpenHands conversations store using the CLI's env precedence. */
export function resolveOpenHandsConversationsPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  const conversationsPath = env.OPENHANDS_CONVERSATIONS_DIR;
  if (conversationsPath) return conversationsPath;
  const persistencePath =
    env.OPENHANDS_PERSISTENCE_DIR || join(homeDir, ".openhands");
  return join(persistencePath, "conversations");
}

function invalidEventFolder(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
