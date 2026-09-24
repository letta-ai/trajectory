import { readFileSync, writeFileSync } from "node:fs";
import {
  listTrajectories,
  normalizeCheckpoint,
  normalizeTranscript,
} from "./index.js";
import type { ListTrajectoriesResult } from "./listing.js";
import type { NormalizeResult } from "./types.js";
import { NormalizationError } from "./types.js";

import { normalizeConversation, type NormalizeConversationResult } from "./conversations/index.js";
import { isObject } from "./adapters/shared.js";

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
  | { ok: true; result: NormalizeResult | ListTrajectoriesResult | NormalizeConversationResult }
  | { ok: false; error: WireError };

async function main(): Promise<void> {
  const request = parseRequest(readFileSync(0, "utf8"));
  const results: WireResult[] = [];
  for (const input of request.requests) {
    try {
      if (isObject(input) && "conversation" in input) {
        const request = input.conversation;
        if (!isObject(request) || typeof request.transcript !== "string" || typeof request.channel !== "string") {
          throw new NormalizationError("invalid_input", "Expected a conversation source, transcript, and channel.");
        }
        if (request.source !== "slack") {
          throw new NormalizationError("unknown_source", "Unsupported conversation source.");
        }
        if (request.users !== undefined && !Array.isArray(request.users)) {
          throw new NormalizationError("invalid_input", "Slack users must be an array.");
        }
        if (request.channelName !== undefined && typeof request.channelName !== "string") {
          throw new NormalizationError("invalid_input", "Channel name must be a string.");
        }
        results.push({ ok: true, result: normalizeConversation({
          source: request.source, transcript: request.transcript, channel: request.channel,
          ...(request.channelName === undefined ? {} : { channelName: request.channelName }),
          ...(request.users === undefined ? {} : { users: request.users }),
        }) });
        continue;
      }
      const result =
        input !== null && typeof input === "object" && "list" in input
          ? await listTrajectories(
              (input as { list: Parameters<typeof listTrajectories>[0] }).list,
            )
          : input !== null &&
              typeof input === "object" &&
              "source" in input &&
              input.source === "deepagents"
            ? await normalizeCheckpoint(
                input as Parameters<typeof normalizeCheckpoint>[0],
              )
            : normalizeTranscript(
                input as Parameters<typeof normalizeTranscript>[0],
              );
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
