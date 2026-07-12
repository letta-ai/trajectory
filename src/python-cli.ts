import { readFileSync, writeFileSync } from "node:fs";
import {
  normalizeCheckpoint,
  normalizeLettaApi,
  normalizeTranscript,
} from "./index.js";
import type { NormalizeResult } from "./types.js";
import { NormalizationError } from "./types.js";

const PROTOCOL_VERSION = 1;

interface WireRequest {
  version: number;
  requests: unknown[];
}

interface WireError {
  name: string;
  code: string;
  message: string;
}

type WireResult =
  | { ok: true; result: NormalizeResult }
  | { ok: false; error: WireError };

async function main(): Promise<void> {
  const request = parseRequest(readFileSync(0, "utf8"));
  const results: WireResult[] = [];
  for (const input of request.requests) {
    try {
      let result: NormalizeResult;
      if (
        input !== null &&
        typeof input === "object" &&
        "source" in input &&
        input.source === "deepagents"
      ) {
        result = await normalizeCheckpoint(
          input as Parameters<typeof normalizeCheckpoint>[0],
        );
      } else if (
        input !== null &&
        typeof input === "object" &&
        "source" in input &&
        input.source === "letta-api"
      ) {
        result = await normalizeLettaApi(
          input as Parameters<typeof normalizeLettaApi>[0],
        );
      } else {
        result = normalizeTranscript(
          input as Parameters<typeof normalizeTranscript>[0],
        );
      }
      results.push({
        ok: true,
        result,
      });
    } catch (error) {
      if (error instanceof NormalizationError) {
        results.push({
          ok: false,
          error: {
            name: error.name,
            code: error.code,
            message: error.message,
          },
        });
        continue;
      }
      results.push({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  writeFileSync(1, JSON.stringify({ version: PROTOCOL_VERSION, results }));
}

function parseRequest(raw: string): WireRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Trajectory bridge input must be valid JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== PROTOCOL_VERSION ||
    !("requests" in value) ||
    !Array.isArray(value.requests)
  ) {
    throw new Error(
      `Trajectory bridge input must contain version ${PROTOCOL_VERSION} and a requests array.`,
    );
  }
  return value as WireRequest;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`trajectory bridge: ${message}\n`);
  process.exitCode = 1;
});
