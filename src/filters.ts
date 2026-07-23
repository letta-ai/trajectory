import type { NormalizationFilters, ToolResultPolicy } from "./types.js";
import { NormalizationError } from "./types.js";

export interface ResolvedNormalizationFilters {
  readonly toolResults: ToolResultPolicy;
}

export const DEFAULT_NORMALIZATION_FILTERS: Readonly<ResolvedNormalizationFilters> =
  Object.freeze({ toolResults: "include" });

export function resolveFilters(
  filters: NormalizationFilters | undefined,
): ResolvedNormalizationFilters {
  if (filters === undefined) return { ...DEFAULT_NORMALIZATION_FILTERS };
  assertObject(filters, "filters");

  const unknown = Object.keys(filters).find((key) => key !== "toolResults");
  if (unknown !== undefined) {
    throw invalidFilters(
      `filters contains unknown option ${JSON.stringify(unknown)}.`,
    );
  }

  const toolResults = filters.toolResults ?? DEFAULT_NORMALIZATION_FILTERS.toolResults;
  if (toolResults !== "include" && toolResults !== "omit") {
    throw invalidFilters(
      'filters.toolResults must be either "include" or "omit".',
    );
  }

  return { toolResults };
}

function assertObject(value: unknown, path: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidFilters(`${path} must be an object.`);
  }
}

function invalidFilters(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
