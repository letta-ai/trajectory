import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { langSmithAdapter } from "./adapters/langsmith.js";
import { lettaAdapter } from "./adapters/letta.js";
import { openHandsAdapter } from "./adapters/openhands.js";
import { resolveBounds } from "./bounds.js";
import { normalizeDecodedSession } from "./core.js";
import type { SourceAdapter } from "./internal.js";
import type {
  NormalizeInput,
  NormalizeResult,
  TrajectorySource,
} from "./types.js";
import { NormalizationError } from "./types.js";

const ADAPTERS: Record<TrajectorySource, SourceAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  langsmith: langSmithAdapter,
  letta: lettaAdapter,
  openhands: openHandsAdapter,
};

export function normalizeTranscript(input: NormalizeInput): NormalizeResult {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (typeof input.transcript !== "string") {
    throw new NormalizationError(
      "invalid_input",
      "Input transcript must be a string containing the source transcript.",
    );
  }

  const adapter = ADAPTERS[input.source];
  if (!adapter) {
    throw new NormalizationError(
      "unknown_source",
      `Unknown trajectory source ${JSON.stringify(input.source)}. Supported sources: ${Object.keys(ADAPTERS).join(", ")}.`,
    );
  }

  const bounds = resolveBounds(input.bounds);
  return normalizeDecodedSession(adapter.decode(input.transcript), bounds);
}

export { DEFAULT_NORMALIZATION_BOUNDS } from "./bounds.js";
export { validateTranscript } from "./validate.js";
export {
  NormalizationError,
  type AssistantMessageRecord,
  type AssistantToolCallRecord,
  type Diagnostic,
  type DiagnosticCode,
  type MetaRecord,
  type NormalizationBounds,
  type NormalizationErrorCode,
  type NormalizedRecord,
  type NormalizedTranscript,
  type NormalizeInput,
  type NormalizeResult,
  type ReasoningRecord,
  type ToolCall,
  type ToolArgumentBounds,
  type ToolResultBounds,
  type ToolResultRecord,
  type ToolResultTruncationStrategy,
  type TrajectorySource,
  type UserRecord,
} from "./types.js";
