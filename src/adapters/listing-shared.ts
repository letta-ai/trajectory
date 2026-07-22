/**
 * Shared helpers for per-adapter local-store listing modules.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrajectoryListing } from "../listing.js";
import { NormalizationError } from "../types.js";

/** Newest-first, id tie-break: the shared ordering for time-stamped listings. */
export function sortListings(items: TrajectoryListing[]): TrajectoryListing[] {
  return items.sort((left, right) => {
    const l = left.updatedAt ?? "";
    const r = right.updatedAt ?? "";
    if (l !== r) return l < r ? 1 : -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Directory entries of `path`, or [] when it does not exist or is unreadable. */
export function safeReadDir(
  path: string,
): { name: string; isDirectory: boolean; isFile: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch {
    return [];
  }
}

export interface FileFacts {
  mtimeMs: number;
  sizeBytes: number;
}

export function safeStat(path: string): FileFacts | undefined {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, sizeBytes: stats.size };
  } catch {
    return undefined;
  }
}

export function listingFromFile(
  id: string,
  path: string,
): TrajectoryListing | undefined {
  const facts = safeStat(path);
  if (!facts) return undefined;
  return {
    id,
    path,
    updatedAt: new Date(facts.mtimeMs).toISOString(),
    sizeBytes: facts.sizeBytes,
  };
}

/** Recursively collect files with `extension` up to `depth` directory levels. */
export function collectFiles(
  root: string,
  extension: string,
  depth: number,
): string[] {
  if (depth < 0) return [];
  const collected: string[] = [];
  for (const entry of safeReadDir(root)) {
    const full = join(root, entry.name);
    if (entry.isFile && entry.name.endsWith(extension)) {
      collected.push(full);
    } else if (entry.isDirectory) {
      collected.push(...collectFiles(full, extension, depth - 1));
    }
  }
  return collected;
}

interface SqliteHandle {
  all(sql: string, ...params: (string | number)[]): Record<string, unknown>[];
  close(): void;
}

const dynamicImport = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

/**
 * Open a SQLite database read-only using whichever built-in driver the runtime
 * provides: `node:sqlite` (Node 22.5+) or `bun:sqlite`. No native dependency
 * is added; older Node versions get a clear error.
 */
export async function openSqliteReadOnly(path: string): Promise<SqliteHandle> {
  let moduleError: unknown;
  try {
    const sqlite = await dynamicImport("node:sqlite");
    const DatabaseSync = sqlite.DatabaseSync as new (
      location: string,
      options?: { readOnly: boolean },
    ) => {
      prepare(sql: string): { all(...params: (string | number)[]): Record<string, unknown>[] };
      close(): void;
    };
    return openWithWalFallback(
      (readOnly) => {
        const database = readOnly
          ? new DatabaseSync(path, { readOnly: true })
          : new DatabaseSync(path);
        return {
          all: (sql, ...params) => database.prepare(sql).all(...params),
          close: () => database.close(),
        };
      },
      path,
    );
  } catch (error) {
    if (error instanceof NormalizationError) throw error;
    if (!isModuleMissing(error)) throw sqliteOpenFailure(path, error);
    moduleError = error;
  }
  try {
    const sqlite = await dynamicImport("bun:sqlite");
    const Database = sqlite.Database as new (
      location: string,
      options?: { readonly: boolean },
    ) => {
      query(sql: string): { all(...params: (string | number)[]): Record<string, unknown>[] };
      close(): void;
    };
    return openWithWalFallback(
      (readOnly) => {
        const database = readOnly
          ? new Database(path, { readonly: true })
          : new Database(path);
        return {
          all: (sql, ...params) => database.query(sql).all(...params),
          close: () => database.close(),
        };
      },
      path,
    );
  } catch (error) {
    if (error instanceof NormalizationError) throw error;
    if (isModuleMissing(error)) {
      throw new NormalizationError(
        "listing_unavailable",
        `Listing this source requires a runtime with built-in SQLite (Node.js 22.5+ or Bun): ${String(
          moduleError instanceof Error ? moduleError.message : moduleError,
        )}`,
      );
    }
    throw sqliteOpenFailure(path, error);
  }
}

/**
 * A WAL-mode database cannot always be opened strictly read-only (SQLite needs
 * the `-shm` sidecar, which a read-only connection may not create), and the
 * failure can surface at the first query rather than at open. Probe with a
 * trivial SELECT and retry with a normal open on failure; only SELECT
 * statements are ever issued either way.
 */
function openWithWalFallback(
  open: (readOnly: boolean) => SqliteHandle,
  path: string,
): SqliteHandle {
  let readOnlyError: unknown;
  for (const readOnly of [true, false]) {
    let handle: SqliteHandle | undefined;
    try {
      handle = open(readOnly);
      handle.all("SELECT 1");
      return handle;
    } catch (error) {
      try {
        handle?.close();
      } catch {
        // The probe failure is the useful error.
      }
      if (readOnly) {
        readOnlyError = error;
        continue;
      }
      throw sqliteOpenFailure(path, readOnlyError ?? error);
    }
  }
  throw sqliteOpenFailure(path, readOnlyError);
}

function sqliteOpenFailure(path: string, error: unknown): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    `Could not open SQLite store ${JSON.stringify(path)}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function isModuleMissing(error: unknown): boolean {
  // Bun rejects unknown builtins with a ResolveMessage, which is not an Error
  // instance, so inspect `code`/`message` structurally.
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
    (typeof message === "string" &&
      /Cannot find (module|package)|No such built-in module/i.test(message))
  );
}
