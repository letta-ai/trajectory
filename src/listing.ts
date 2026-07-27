/**
 * Local-store trajectory listing. This is a discovery layer that runs beside
 * normalization, not inside it: `normalizeTranscript()` stays filesystem-free,
 * while `listTrajectories()` enumerates the sessions a local store contains so
 * a caller can then read and normalize them.
 *
 * Listings are paginated with an opaque cursor. Each adapter returns its items
 * newest-first (by store timestamp when one exists); pagination is positional
 * over that order and is best-effort stable when the store changes between
 * pages.
 */

import { listClaudeCodeTrajectories } from "./adapters/claude-code/list.js";
import { listCodexTrajectories } from "./adapters/codex/list.js";
import { listDroidTrajectories } from "./adapters/droid/list.js";
import { listDeepAgentsTrajectories } from "./adapters/deepagents/list.js";
import { listHermesTrajectories } from "./adapters/hermes/list.js";
import { listLettaCodeTrajectories } from "./adapters/letta-code/list.js";
import { listOpenClawTrajectories } from "./adapters/openclaw/list.js";
import { listOpenHandsTrajectories } from "./adapters/openhands/list.js";
import { listPiTrajectories } from "./adapters/pi/list.js";
import { listOmpTrajectories } from "./adapters/omp/list.js";
import type { AnyTrajectorySource } from "./types.js";
import { NormalizationError } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export interface TrajectoryListing {
  /** Source-native session identity: session/thread/conversation id or file stem. */
  id: string;
  /**
   * Filesystem locator for the next step: the transcript file to read, the
   * SQLite store containing the session, or the session's event directory.
   */
  path: string;
  /** Last-activity time (ISO-8601) when the store exposes one. */
  updatedAt?: string;
  /** Human-readable title when the store keeps one. */
  title?: string;
  /** Transcript size in bytes for file-backed stores. */
  sizeBytes?: number;
}

export interface ListTrajectoriesInput {
  source: AnyTrajectorySource;
  /** Store root override. Defaults to the source's standard local location. */
  root?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Page size; defaults to 50, capped at 1000. */
  limit?: number;
}

export interface ListTrajectoriesResult {
  items: TrajectoryListing[];
  /** Present exactly when more items remain. */
  nextCursor?: string;
}

type SourceLister = (root: string | undefined) => Promise<TrajectoryListing[]>;

const LISTERS: Record<AnyTrajectorySource, SourceLister> = {
  "claude-code": listClaudeCodeTrajectories,
  codex: listCodexTrajectories,
  droid: listDroidTrajectories,
  deepagents: listDeepAgentsTrajectories,
  hermes: listHermesTrajectories,
  "letta-code": listLettaCodeTrajectories,
  openclaw: listOpenClawTrajectories,
  openhands: listOpenHandsTrajectories,
  pi: listPiTrajectories,
  omp: listOmpTrajectories,
};

/**
 * List the trajectories present in a source's local store, newest first. A
 * missing store yields an empty listing rather than an error, so callers can
 * probe all sources uniformly.
 */
export async function listTrajectories(
  input: ListTrajectoriesInput,
): Promise<ListTrajectoriesResult> {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  const lister = LISTERS[input.source];
  if (!lister) {
    throw new NormalizationError(
      "unknown_source",
      `Unknown trajectory source ${JSON.stringify(input.source)}. Supported sources: ${Object.keys(LISTERS).join(", ")}.`,
    );
  }
  if (
    input.root !== undefined &&
    (typeof input.root !== "string" || !input.root)
  ) {
    throw new NormalizationError(
      "invalid_input",
      "root must be a non-empty string when provided.",
    );
  }
  const limit = resolveLimit(input.limit);
  const items = await lister(input.root);
  return paginate(items, input.cursor, limit);
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new NormalizationError(
      "invalid_input",
      `limit must be an integer between 1 and ${MAX_LIMIT}.`,
    );
  }
  return limit;
}

interface CursorState {
  v: 1;
  /** id of the last item already delivered. */
  id: string;
  /** Position of that item in the listing when the cursor was minted. */
  i: number;
}

function paginate(
  items: TrajectoryListing[],
  cursor: string | undefined,
  limit: number,
): ListTrajectoriesResult {
  let start = 0;
  if (cursor !== undefined) {
    const state = decodeCursor(cursor);
    const index = items.findIndex((item) => item.id === state.id);
    // If the cursor item vanished between pages, resume from its recorded
    // position so a churning store degrades to positional pagination instead
    // of restarting or failing.
    start = index >= 0 ? index + 1 : Math.min(state.i + 1, items.length);
  }
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  const last = page[page.length - 1];
  if (end >= items.length || last === undefined) {
    return { items: page };
  }
  return {
    items: page,
    nextCursor: encodeCursor({ v: 1, id: last.id, i: end - 1 }),
  };
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as CursorState).v !== 1 ||
    typeof (parsed as CursorState).id !== "string" ||
    !Number.isInteger((parsed as CursorState).i) ||
    (parsed as CursorState).i < 0
  ) {
    throw invalidCursor();
  }
  return parsed as CursorState;
}

function invalidCursor(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "cursor is not a valid trajectory-listing cursor.",
  );
}
