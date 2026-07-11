import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  DeepAgentsCheckpointData,
  DeepAgentsCheckpointLocation,
  DeepAgentsMessageData,
  DeepAgentsToolCall,
  NormalizationErrorCode,
} from "./types.js";
import { NormalizationError } from "./types.js";

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024 * 1024;

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
 * Load one Python Deep Agents/LangGraph SQLite checkpoint.
 *
 * The helper delegates SQLite selection, serializer decoding, DeltaChannel
 * parent traversal, and message reduction to the installed Python LangGraph
 * packages. No checkpoint blob is decoded by trajectory itself.
 */
export async function loadDeepAgentsCheckpoint(
  checkpoint: DeepAgentsCheckpointLocation,
): Promise<DeepAgentsCheckpointData> {
  validateLocation(checkpoint);
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
      resolve(response.data);
    });

    child.stdin.on("error", () => {
      // A process-start/exit handler reports the useful error.
    });
    child.stdin.end(
      JSON.stringify({
        path: checkpoint.path,
        threadId: checkpoint.threadId,
        checkpointNamespace: checkpoint.checkpointNamespace ?? "",
        ...(checkpoint.checkpointId
          ? { checkpointId: checkpoint.checkpointId }
          : {}),
      }),
    );
  });
}

function validateLocation(checkpoint: DeepAgentsCheckpointLocation): void {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint location must be an object.",
    );
  }
  if (typeof checkpoint.path !== "string" || !checkpoint.path) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.path is required.",
    );
  }
  if (typeof checkpoint.threadId !== "string" || !checkpoint.threadId) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.threadId is required because the SDK has no standard thread.",
    );
  }
  if (
    checkpoint.checkpointNamespace !== undefined &&
    typeof checkpoint.checkpointNamespace !== "string"
  ) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.checkpointNamespace must be a string.",
    );
  }
  if (
    checkpoint.checkpointId !== undefined &&
    (typeof checkpoint.checkpointId !== "string" || !checkpoint.checkpointId)
  ) {
    throw new NormalizationError(
      "invalid_input",
      "Deep Agents checkpoint.checkpointId must be a non-empty string.",
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
