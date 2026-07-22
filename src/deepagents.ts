/**
 * Deep Agents support, consolidated: the public checkpoint API, the location
 * and decoded-data types, the Python LangGraph subprocess loader, and the
 * decoder into the shared internal event contract.
 *
 * Deep Agents has no transcript format — sessions persist as LangGraph SQLite
 * checkpoints — so this integration reads the Deep Agents CLI session store
 * (`~/.deepagents/sessions.db` by default) for one thread and normalizes its
 * latest state.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonString, parseTimestamp } from "./adapters/shared.js";
import type { ResolvedNormalizationBounds } from "./bounds.js";
import { resolveBounds } from "./bounds.js";
import { finalizeCanonical, GROUP_SENTINEL } from "./canonical.js";
import {
  normalizeDecodedSession,
  normalizeDecodedSessionInternal,
} from "./core.js";
import type { DecodedEvent, DecodedSession } from "./internal.js";
import type {
  CanonicalResult,
  NormalizationBounds,
  NormalizationErrorCode,
  NormalizeResult,
} from "./types.js";
import { NormalizationError } from "./types.js";

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface DeepAgentsCheckpointLocation {
  /** LangGraph thread_id, as listed by the Deep Agents CLI session picker. */
  threadId: string;
  /**
   * Path to the LangGraph SQLite store. Defaults to the Deep Agents CLI store,
   * `~/.deepagents/sessions.db`. Pass a path for a non-default store location.
   */
  path?: string;
  /** Python interpreter containing LangGraph and langgraph-checkpoint-sqlite. */
  pythonExecutable?: string;
}

export interface DeepAgentsCheckpointInput {
  source: "deepagents";
  checkpoint: DeepAgentsCheckpointLocation;
  bounds?: NormalizationBounds;
}

export interface DeepAgentsToolCall {
  id?: string;
  name?: string;
  args: unknown;
}

export interface DeepAgentsHumanMessageData {
  role: "human";
  content: string;
  timestamp?: string;
}

export interface DeepAgentsAIMessageData {
  role: "ai";
  content: string;
  reasoning: string[];
  toolCalls: DeepAgentsToolCall[];
  model?: string;
  timestamp?: string;
}

export interface DeepAgentsToolMessageData {
  role: "tool";
  content: string;
  toolCallId: string;
  timestamp?: string;
}

export type DeepAgentsMessageData =
  | DeepAgentsHumanMessageData
  | DeepAgentsAIMessageData
  | DeepAgentsToolMessageData;

export interface DeepAgentsCheckpointData {
  /** LangGraph thread_id the checkpoint was selected by; part of the group identity. */
  threadId: string;
  checkpointId: string;
  checkpointNamespace: string;
  checkpointTimestamp: string;
  cwd?: string;
  model?: string;
  messages: DeepAgentsMessageData[];
}

/** Normalize the latest state of one Deep Agents thread from its local store. */
export async function normalizeCheckpoint(
  input: DeepAgentsCheckpointInput,
): Promise<NormalizeResult> {
  const { decoded, bounds } = await decodeCheckpoint(input);
  return normalizeDecodedSession(decoded, bounds);
}

/** Canonical view of a Deep Agents thread, mirroring `normalizeToCanonical`. */
export async function normalizeCheckpointToCanonical(
  input: DeepAgentsCheckpointInput,
): Promise<CanonicalResult> {
  const { decoded, bounds } = await decodeCheckpoint(input);
  const internal = normalizeDecodedSessionInternal(decoded, bounds);
  return finalizeCanonical(internal, bounds, {
    groupId: internal.context.sourceGroupId || GROUP_SENTINEL,
    baseByteOffset: 0,
    emitMeta: true,
  });
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

interface HelperSuccess {
  ok: true;
  data: DeepAgentsCheckpointData;
}

interface HelperFailure {
  ok: false;
  code: NormalizationErrorCode;
  message: string;
}

/**
 * Load the latest LangGraph SQLite checkpoint for one Deep Agents thread. The
 * store defaults to the Deep Agents CLI database (`~/.deepagents/sessions.db`),
 * which is the only standard local Deep Agents store; threads live in the root
 * checkpoint namespace there.
 *
 * The helper delegates SQLite selection, serializer decoding, DeltaChannel
 * parent traversal, and message reduction to the installed Python LangGraph
 * packages. No checkpoint blob is decoded by trajectory itself.
 */
export async function loadDeepAgentsCheckpoint(
  checkpoint: DeepAgentsCheckpointLocation,
): Promise<DeepAgentsCheckpointData> {
  validateLocation(checkpoint);
  const path = checkpoint.path ?? join(homedir(), ".deepagents", "sessions.db");
  const python = checkpoint.pythonExecutable ?? process.env.PYTHON ?? "python3";
  const helper = resolveHelperPath();

  return await new Promise<DeepAgentsCheckpointData>((resolve, reject) => {
    const child = spawn(python, [helper], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        fail(
          new NormalizationError(
            "python_unavailable",
            `Could not execute Python interpreter ${JSON.stringify(python)}. ` +
              "Pass checkpoint.pythonExecutable or set PYTHON.",
          ),
        );
        return;
      }
      fail(
        new NormalizationError(
          "checkpoint_read_failed",
          `Could not start the Deep Agents checkpoint helper: ${error.message}`,
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill();
        fail(
          new NormalizationError(
            "checkpoint_read_failed",
            "Deep Agents checkpoint helper output exceeded 64 MiB.",
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new NormalizationError(
            "checkpoint_read_failed",
            `Deep Agents checkpoint helper failed${detail ? `: ${detail}` : ` with exit code ${code}`}.`,
          ),
        );
        return;
      }

      let response: unknown;
      try {
        response = JSON.parse(raw);
      } catch {
        reject(
          new NormalizationError(
            "checkpoint_read_failed",
            "Deep Agents checkpoint helper returned invalid JSON.",
          ),
        );
        return;
      }
      if (isHelperFailure(response)) {
        reject(new NormalizationError(response.code, response.message));
        return;
      }
      if (!isHelperSuccess(response)) {
        reject(
          new NormalizationError(
            "invalid_checkpoint_state",
            "Deep Agents checkpoint helper returned an invalid message envelope.",
          ),
        );
        return;
      }
      // The Python helper does not echo the thread; carry it from the request so
      // the checkpoint's group identity is unique per (threadId, namespace).
      resolve({ ...response.data, threadId: checkpoint.threadId });
    });

    child.stdin.on("error", () => {
      // A process-start/exit handler reports the useful error.
    });
    // The CLI store keeps every thread in the root checkpoint namespace, and
    // the latest checkpoint is the session's current state.
    child.stdin.end(
      JSON.stringify({
        path,
        threadId: checkpoint.threadId,
        checkpointNamespace: "",
      }),
    );
  });
}

export function decodeDeepAgentsCheckpoint(
  checkpoint: DeepAgentsCheckpointData,
): DecodedSession {
  const events: DecodedEvent[] = [];
  const checkpointTimestamp = parseTimestamp(checkpoint.checkpointTimestamp);

  checkpoint.messages.forEach((message, offset) => {
    const timestamp = parseTimestamp(message.timestamp) ?? checkpointTimestamp;
    // Deep Agents messages carry no native per-message id, so identity is
    // anchored to the message offset within the checkpoint (kind `location`).
    let componentIndex = 0;
    const emit = (event: DecodedEvent): void => {
      events.push({
        ...event,
        sourceOffset: offset,
        sourceAnchorKind: "ordinal",
        componentIndex: componentIndex++,
      });
    };

    if (message.role === "human") {
      if (message.content) {
        emit({
          type: "message",
          role: "user",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
        });
      }
      return;
    }
    if (message.role === "ai") {
      for (const reasoning of message.reasoning) {
        if (!reasoning) continue;
        emit({
          type: "reasoning",
          content: reasoning,
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      if (message.content) {
        emit({
          type: "message",
          role: "assistant",
          content: message.content,
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      for (const call of message.toolCalls) {
        emit({
          type: "tool_call",
          args: jsonString(call.args),
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(message.model ? { model: message.model } : {}),
        });
      }
      return;
    }
    emit({
      type: "tool_result",
      callId: message.toolCallId,
      content: message.content,
      ...(timestamp ? { timestamp } : {}),
    });
  });

  return {
    events,
    context: {
      source: "deepagents",
      ...(checkpoint.cwd ? { cwd: checkpoint.cwd } : {}),
      ...(checkpoint.model ? { model: checkpoint.model } : {}),
      ...(checkpointTimestamp ? { createdAt: checkpointTimestamp } : {}),
      sourceGroupId: deepAgentsGroupId(
        checkpoint.threadId,
        checkpoint.checkpointNamespace,
      ),
    },
    diagnostics: [],
  };
}

/**
 * Group identity for a Deep Agents checkpoint. Different namespaces are distinct
 * checkpoint streams whose offset-derived identities would otherwise collide, so
 * the group uniquely encodes the `(threadId, checkpointNamespace)` pair. The pair
 * is encoded uniformly for every namespace (including root) so no thread id whose
 * literal value looks like the encoding can collide with a real pair.
 */
function deepAgentsGroupId(threadId: string, checkpointNamespace: string): string {
  return JSON.stringify([threadId, checkpointNamespace]);
}

function validateLocation(checkpoint: DeepAgentsCheckpointLocation): void {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint location must be an object.",
    );
  }
  if (typeof checkpoint.threadId !== "string" || !checkpoint.threadId) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.threadId is required; the CLI session picker lists thread ids.",
    );
  }
  if (
    checkpoint.path !== undefined &&
    (typeof checkpoint.path !== "string" || !checkpoint.path)
  ) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.path must be a non-empty string when provided.",
    );
  }
  if (
    checkpoint.pythonExecutable !== undefined &&
    (typeof checkpoint.pythonExecutable !== "string" || !checkpoint.pythonExecutable)
  ) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.pythonExecutable must be a non-empty string.",
    );
  }
}

function resolveHelperPath(): string {
  const candidates = [
    fileURLToPath(new URL("../helpers/deepagents_checkpoint.py", import.meta.url)),
    fileURLToPath(new URL("./deepagents_checkpoint.py", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the bundled Python-package location next.
    }
  }
  throw new NormalizationError(
    "checkpoint_read_failed",
    "The Deep Agents checkpoint helper is missing from this trajectory installation.",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHelperFailure(value: unknown): value is HelperFailure {
  return (
    isObject(value) &&
    value.ok === false &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isHelperSuccess(value: unknown): value is HelperSuccess {
  return isObject(value) && value.ok === true && isCheckpointData(value.data);
}

function isCheckpointData(value: unknown): value is DeepAgentsCheckpointData {
  return (
    isObject(value) &&
    typeof value.checkpointId === "string" &&
    typeof value.checkpointNamespace === "string" &&
    typeof value.checkpointTimestamp === "string" &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessageData)
  );
}

function isMessageData(value: unknown): value is DeepAgentsMessageData {
  if (!isObject(value) || typeof value.content !== "string") return false;
  if (value.timestamp !== undefined && typeof value.timestamp !== "string") {
    return false;
  }
  if (value.role === "human") return true;
  if (value.role === "ai") return isAIData(value);
  if (value.role === "tool") return typeof value.toolCallId === "string";
  return false;
}

function isAIData(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.reasoning) &&
    value.reasoning.every((item) => typeof item === "string") &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isToolCall) &&
    (value.model === undefined || typeof value.model === "string")
  );
}

function isToolCall(value: unknown): value is DeepAgentsToolCall {
  return (
    isObject(value) &&
    "args" in value &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.name === undefined || typeof value.name === "string")
  );
}
