import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TrajectoryListing } from "../../listing.js";
import { listingFromFile, safeReadDir, sortListings } from "../listing-shared.js";

/**
 * OMP sessions: `<agentDir>/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl`,
 * where the escaped cwd encodes the working directory (home-relative `-<rel>`
 * with `/` replaced by `-`, or the legacy `--<abs>--` form). The agent
 * directory follows OMP's current `getSessionsDir()` resolution: active named
 * profile, `PI_CODING_AGENT_DIR` for the default profile, `PI_CONFIG_DIR`, and
 * a migrated XDG data root when present.
 *
 * OMP additionally nests per-session subagent transcripts one level deeper
 * (`<timestamp>_<uuid>/<name>.jsonl`); those are not enumerated by this
 * lister, which mirrors the pi adapter and captures primary session
 * transcripts.
 */
export async function listOmpTrajectories(
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const items: TrajectoryListing[] = [];
  const sessionsPath = root
    ? join(root, "sessions")
    : resolveOmpSessionsPath({
        home: homedir(),
        platform: process.platform,
        env: process.env,
        exists: existsSync,
      });
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

interface OmpPathEnvironment {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
}

/** Mirror the path inputs used by OMP's `getSessionsDir()`. */
export function resolveOmpSessionsPath(options: OmpPathEnvironment): string {
  const profile = resolveProfile(options.env.OMP_PROFILE, options.env.PI_PROFILE);
  const configRoot = join(
    options.home,
    options.env.PI_CONFIG_DIR || ".omp",
    ...(profile ? ["profiles", profile] : []),
  );
  const agentOverride = profile
    ? undefined
    : options.env.PI_CODING_AGENT_DIR?.trim() || undefined;
  const agentDir = agentOverride ?? join(configRoot, "agent");

  if (
    agentOverride === undefined &&
    (options.platform === "linux" || options.platform === "darwin")
  ) {
    const xdgData = options.env.XDG_DATA_HOME?.trim();
    if (xdgData) {
      const xdgRoot = join(
        xdgData,
        "omp",
        ...(profile ? ["profiles", profile] : []),
      );
      if (options.exists(xdgRoot)) return join(xdgRoot, "sessions");
    }
  }

  return join(agentDir, "sessions");
}

function resolveProfile(
  ompProfile: string | undefined,
  piProfile: string | undefined,
): string | undefined {
  const value = (ompProfile !== undefined ? ompProfile : piProfile)?.trim();
  if (!value || value === "default") return undefined;
  if (
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ||
    /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(value)
  ) {
    return undefined;
  }
  return value;
}
