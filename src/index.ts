import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { lettaAdapter } from "./adapters/letta.js";
import { openHandsAdapter } from "./adapters/openhands.js";
import { decodeDeepAgentsCheckpoint } from "./adapters/deepagents.js";
import type { ResolvedNormalizationBounds } from "./bounds.js";
import { resolveBounds } from "./bounds.js";
import { buildCanonicalRecords } from "./canonical.js";
import {
  normalizeDecodedSession,
  normalizeDecodedSessionInternal,
} from "./core.js";
import { loadDeepAgentsCheckpoint } from "./deepagents-checkpoint.js";
import type { DecodedSession, SourceAdapter } from "./internal.js";
import type {
  CanonicalResult,
  DeepAgentsCheckpointInput,
  NormalizeInput,
  NormalizeResult,
  TranscriptTrajectorySource,
} from "./types.js";
import { NormalizationError } from "./types.js";
import { CANONICAL_SCHEMA_VERSION, NORMALIZER_VERSION } from "./version.js";

const ADAPTERS: Record<TranscriptTrajectorySource, SourceAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  letta: lettaAdapter,
  openhands: openHandsAdapter,
};

function decodeTranscript(input: NormalizeInput): {
  decoded: DecodedSession;
  bounds: ResolvedNormalizationBounds;
} {
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

  return { decoded: adapter.decode(input.transcript), bounds: resolveBounds(input.bounds) };
}

export function normalizeTranscript(input: NormalizeInput): NormalizeResult {
  const { decoded, bounds } = decodeTranscript(input);
  return normalizeDecodedSession(decoded, bounds);
}

/**
 * Normalize a transcript into canonical, ingestion-ready records for the Cloud
 * normalizer worker. The trajectory-v1 output of {@link normalizeTranscript} is
 * unchanged; this is an additive, richer view carrying source-native identity,
 * ordering, and hashing metadata. See CANONICAL.md for the field contract.
 */
export function normalizeToCanonical(input: NormalizeInput): CanonicalResult {
  const { decoded, bounds } = decodeTranscript(input);
  return finalizeCanonical(normalizeDecodedSessionInternal(decoded, bounds), bounds);
}

/** Normalize a Python Deep Agents SDK checkpoint selected by path and thread. */
export async function normalizeCheckpoint(
  input: DeepAgentsCheckpointInput,
): Promise<NormalizeResult> {
  const { decoded, bounds } = await decodeCheckpoint(input);
  return normalizeDecodedSession(decoded, bounds);
}

/** Canonical view of a Deep Agents SDK checkpoint, mirroring {@link normalizeToCanonical}. */
export async function normalizeCheckpointToCanonical(
  input: DeepAgentsCheckpointInput,
): Promise<CanonicalResult> {
  const { decoded, bounds } = await decodeCheckpoint(input);
  return finalizeCanonical(normalizeDecodedSessionInternal(decoded, bounds), bounds);
}

async function decodeCheckpoint(input: DeepAgentsCheckpointInput): Promise<{
  decoded: DecodedSession;
  bounds: ResolvedNormalizationBounds;
}> {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (input.source !== "deepagents") {
    throw new NormalizationError(
      "unknown_source",
      `Checkpoint source must be "deepagents"; received ${JSON.stringify(input.source)}.`,
    );
  }
  const checkpoint = await loadDeepAgentsCheckpoint(input.checkpoint);
  return {
    decoded: decodeDeepAgentsCheckpoint(checkpoint),
    bounds: resolveBounds(input.bounds),
  };
}

function finalizeCanonical(
  internal: ReturnType<typeof normalizeDecodedSessionInternal>,
  bounds: ResolvedNormalizationBounds,
): CanonicalResult {
  return {
    records: buildCanonicalRecords(internal),
    diagnostics: internal.diagnostics,
    normalizer_version: NORMALIZER_VERSION,
    canonical_schema_version: CANONICAL_SCHEMA_VERSION,
    config: { bounds },
  };
}

export { loadDeepAgentsCheckpoint } from "./deepagents-checkpoint.js";
export { CANONICAL_SCHEMA_VERSION, NORMALIZER_VERSION } from "./version.js";

export { DEFAULT_NORMALIZATION_BOUNDS } from "./bounds.js";
export { validateTranscript } from "./validate.js";
export {
  NormalizationError,
  type AssistantMessageRecord,
  type AssistantToolCallRecord,
  type AnyTrajectorySource,
  type CanonicalRecord,
  type CanonicalRecordType,
  type CanonicalResult,
  type CheckpointTrajectorySource,
  type Diagnostic,
  type DiagnosticCode,
  type DeepAgentsAIMessageData,
  type DeepAgentsCheckpointData,
  type DeepAgentsCheckpointInput,
  type DeepAgentsCheckpointLocation,
  type DeepAgentsHumanMessageData,
  type DeepAgentsMessageData,
  type DeepAgentsToolCall,
  type DeepAgentsToolMessageData,
  type MetaRecord,
  type NormalizationBounds,
  type NormalizationErrorCode,
  type NormalizedRecord,
  type NormalizedTranscript,
  type NormalizeInput,
  type NormalizeResult,
  type ReasoningRecord,
  type SourceIdentityKind,
  type ToolCall,
  type ToolArgumentBounds,
  type ToolResultBounds,
  type ToolResultRecord,
  type ToolResultTruncationStrategy,
  type TranscriptTrajectorySource,
  type TrajectorySource,
  type UserRecord,
} from "./types.js";
export type { ResolvedNormalizationBounds } from "./bounds.js";
