import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { deepAgentsCodeAdapter } from "./adapters/deepagents-code.js";
import { lettaAdapter } from "./adapters/letta.js";
import { openHandsAdapter } from "./adapters/openhands.js";
import { decodeDeepAgentsCheckpoint } from "./adapters/deepagents.js";
import { resolveBounds } from "./bounds.js";
import { normalizeDecodedSession } from "./core.js";
import { loadDeepAgentsCheckpoint } from "./deepagents-checkpoint.js";
import type { SourceAdapter } from "./internal.js";
import type {
  DeepAgentsCheckpointInput,
  NormalizeDeepAgentsCodeInput,
  NormalizeInput,
  NormalizeResult,
  TranscriptTrajectorySource,
} from "./types.js";
import { NormalizationError } from "./types.js";

const ADAPTERS: Record<TranscriptTrajectorySource, SourceAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  "deepagents-code": deepAgentsCodeAdapter,
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

/** Normalize a Python Deep Agents SDK checkpoint selected by path and thread. */
export async function normalizeCheckpoint(
  input: DeepAgentsCheckpointInput,
): Promise<NormalizeResult> {
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
  return normalizeDecodedSession(
    decodeDeepAgentsCheckpoint(checkpoint),
    resolveBounds(input.bounds),
  );
}

/** Display form of the fixed Deep Agents Code local checkpoint path. */
export const DEEP_AGENTS_CODE_DEFAULT_DATABASE_PATH =
  "~/.deepagents/.state/sessions.db";

/** Normalize one explicitly selected thread from Deep Agents Code's local store. */
export async function normalizeDeepAgentsCode(
  input: NormalizeDeepAgentsCodeInput,
): Promise<NormalizeResult> {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (typeof input.threadId !== "string" || !input.threadId) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents Code threadId must be a non-empty string.",
    );
  }

  const result = await normalizeCheckpoint({
    source: "deepagents",
    checkpoint: {
      path: resolveDeepAgentsCodeDatabasePath(),
      threadId: input.threadId,
      ...(input.checkpointNamespace !== undefined
        ? { checkpointNamespace: input.checkpointNamespace }
        : {}),
      ...(input.checkpointId !== undefined
        ? { checkpointId: input.checkpointId }
        : {}),
      ...(input.pythonExecutable !== undefined
        ? { pythonExecutable: input.pythonExecutable }
        : {}),
    },
    ...(input.bounds !== undefined ? { bounds: input.bounds } : {}),
  });

  const [meta, ...records] = result.records;
  if (!meta || meta.role !== "meta") {
    throw new NormalizationError(
      "invalid_normalized_transcript",
      "Deep Agents checkpoint normalization did not produce a leading meta record.",
    );
  }
  return {
    records: [{ ...meta, source: "deepagents-code" }, ...records],
    diagnostics: result.diagnostics,
  };
}

function resolveDeepAgentsCodeDatabasePath(): string {
  return join(resolveHomeDirectory(), ".deepagents", ".state", "sessions.db");
}

function resolveHomeDirectory(): string {
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE;
    if (profile) return profile;
    const drive = process.env.HOMEDRIVE;
    const path = process.env.HOMEPATH;
    if (drive && path) return `${drive}${path}`;
  } else if (process.env.HOME) {
    return process.env.HOME;
  }
  return homedir();
}

export { loadDeepAgentsCheckpoint } from "./deepagents-checkpoint.js";

export { DEFAULT_NORMALIZATION_BOUNDS } from "./bounds.js";
export type {
  DeepAgentsCodeMessage,
  DeepAgentsCodeMetadata,
  DeepAgentsCodeTranscriptEnvelope,
} from "./adapters/deepagents-code.js";
export { validateTranscript } from "./validate.js";
export {
  NormalizationError,
  type AssistantMessageRecord,
  type AssistantToolCallRecord,
  type AnyTrajectorySource,
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
  type NormalizeDeepAgentsCodeInput,
  type NormalizeResult,
  type ReasoningRecord,
  type ToolCall,
  type ToolArgumentBounds,
  type ToolResultBounds,
  type ToolResultRecord,
  type ToolResultTruncationStrategy,
  type TranscriptTrajectorySource,
  type TrajectorySource,
  type UserRecord,
} from "./types.js";
