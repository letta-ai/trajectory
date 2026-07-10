import type {
  NormalizationBounds,
  ToolResultTruncationStrategy,
} from "./types.js";
import { NormalizationError } from "./types.js";

export interface ResolvedNormalizationBounds {
  readonly toolArguments: {
    readonly maxCharacters: number | null;
  };
  readonly toolResults: {
    readonly maxCharacters: number | null;
    readonly strategy: ToolResultTruncationStrategy;
  };
}

export const DEFAULT_NORMALIZATION_BOUNDS: Readonly<ResolvedNormalizationBounds> =
  Object.freeze({
    toolArguments: Object.freeze({ maxCharacters: 20_000 }),
    toolResults: Object.freeze({
      maxCharacters: 2_500,
      strategy: "head-tail",
    }),
  });

export function resolveBounds(
  bounds: NormalizationBounds | undefined,
): ResolvedNormalizationBounds {
  if (bounds === undefined) return copyDefaults();
  assertObject(bounds, "bounds");
  assertKnownKeys(bounds, ["toolArguments", "toolResults"], "bounds");

  const toolArguments = bounds.toolArguments;
  if (toolArguments !== undefined) {
    assertObject(toolArguments, "bounds.toolArguments");
    assertKnownKeys(
      toolArguments,
      ["maxCharacters"],
      "bounds.toolArguments",
    );
  }

  const toolResults = bounds.toolResults;
  if (toolResults !== undefined) {
    assertObject(toolResults, "bounds.toolResults");
    assertKnownKeys(
      toolResults,
      ["maxCharacters", "strategy"],
      "bounds.toolResults",
    );
  }

  const argumentLimit = resolveLimit(
    toolArguments?.maxCharacters,
    DEFAULT_NORMALIZATION_BOUNDS.toolArguments.maxCharacters,
    "bounds.toolArguments.maxCharacters",
  );
  if (argumentLimit !== null && argumentLimit < 2) {
    throw invalidBounds(
      "bounds.toolArguments.maxCharacters must be at least 2 so arguments can remain a JSON object.",
    );
  }

  const resultLimit = resolveLimit(
    toolResults?.maxCharacters,
    DEFAULT_NORMALIZATION_BOUNDS.toolResults.maxCharacters,
    "bounds.toolResults.maxCharacters",
  );
  const strategy =
    toolResults?.strategy ?? DEFAULT_NORMALIZATION_BOUNDS.toolResults.strategy;
  if (strategy !== "head" && strategy !== "head-tail") {
    throw invalidBounds(
      'bounds.toolResults.strategy must be either "head" or "head-tail".',
    );
  }

  return {
    toolArguments: { maxCharacters: argumentLimit },
    toolResults: { maxCharacters: resultLimit, strategy },
  };
}

function copyDefaults(): ResolvedNormalizationBounds {
  return {
    toolArguments: {
      maxCharacters: DEFAULT_NORMALIZATION_BOUNDS.toolArguments.maxCharacters,
    },
    toolResults: {
      maxCharacters: DEFAULT_NORMALIZATION_BOUNDS.toolResults.maxCharacters,
      strategy: DEFAULT_NORMALIZATION_BOUNDS.toolResults.strategy,
    },
  };
}

function resolveLimit(
  value: number | null | undefined,
  fallback: number | null,
  path: string,
): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidBounds(`${path} must be a positive safe integer or null.`);
  }
  return value;
}

function assertObject(value: unknown, path: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBounds(`${path} must be an object.`);
  }
}

function assertKnownKeys(
  value: object,
  knownKeys: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !knownKeys.includes(key));
  if (unknown !== undefined) {
    throw invalidBounds(`${path} contains unknown option ${JSON.stringify(unknown)}.`);
  }
}

function invalidBounds(message: string): NormalizationError {
  return new NormalizationError("invalid_input", message);
}
