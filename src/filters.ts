import type {
  NormalizationFilters,
  SystemMessagePolicy,
  ToolResultPolicy,
} from "./types.js";
import { NormalizationError } from "./types.js";

export interface ResolvedNormalizationFilters {
  readonly toolResults: ToolResultPolicy;
  readonly systemMessages: SystemMessagePolicy;
}

export const DEFAULT_NORMALIZATION_FILTERS: Readonly<ResolvedNormalizationFilters> =
  Object.freeze({ toolResults: "include", systemMessages: "omit" });

export function resolveFilters(
  filters: NormalizationFilters | undefined,
): ResolvedNormalizationFilters {
  if (filters === undefined) return { ...DEFAULT_NORMALIZATION_FILTERS };
  assertObject(filters, "filters");

  const unknown = Object.keys(filters).find(
    (key) => key !== "toolResults" && key !== "systemMessages",
  );
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

  const systemMessages =
    filters.systemMessages ?? DEFAULT_NORMALIZATION_FILTERS.systemMessages;
  if (systemMessages !== "include" && systemMessages !== "omit") {
    throw invalidFilters(
      'filters.systemMessages must be either "include" or "omit".',
    );
  }

  return { toolResults, systemMessages };
}

function assertObject(value: unknown, path: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidFilters(`${path} must be an object.`);
  }
}

function invalidFilters(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
