import { normalizeDecodedSession } from "./core.js";
import { lettaAdapter } from "./adapters/letta.js";
import { resolveBounds } from "./bounds.js";
import type { LettaApiInput, NormalizeResult } from "./types.js";
import { NormalizationError } from "./types.js";

const DEFAULT_BASE_URL = "https://api.letta.com";
const PAGE_SIZE = 100;

/** Fetch and normalize a complete remote Letta message history. */
export async function normalizeLettaApi(
  input: LettaApiInput,
): Promise<NormalizeResult> {
  validateInput(input);

  const apiKey = input.apiKey ?? process.env.LETTA_API_KEY;
  if (!apiKey) {
    throw new NormalizationError(
      "letta_api_auth_missing",
      "A Letta API key is required. Pass apiKey or set LETTA_API_KEY.",
    );
  }

  const messages = await fetchAllMessages(input, apiKey);
  return normalizeDecodedSession(
    lettaAdapter.decode(JSON.stringify(messages)),
    resolveBounds(input.bounds),
  );
}

async function fetchAllMessages(
  input: LettaApiInput,
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  let after: string | undefined;

  for (;;) {
    const url = messagesUrl(input, after);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      throw new NormalizationError(
        "letta_api_request_failed",
        `Failed to fetch Letta messages: ${errorMessage(error)}.`,
      );
    }

    if (!response.ok) {
      throw new NormalizationError(
        "letta_api_request_failed",
        `Letta messages request failed with HTTP ${response.status}.`,
      );
    }

    let page: unknown;
    try {
      page = await response.json();
    } catch {
      throw new NormalizationError(
        "letta_api_response_invalid",
        "The Letta messages API returned invalid JSON.",
      );
    }
    if (!Array.isArray(page) || !page.every(isObject)) {
      throw new NormalizationError(
        "letta_api_response_invalid",
        "The Letta messages API response must be an array of message objects.",
      );
    }

    messages.push(...page);
    if (page.length < PAGE_SIZE) break;

    const lastId = page.at(-1)?.id;
    if (typeof lastId !== "string" || !lastId || lastId === after) {
      throw new NormalizationError(
        "letta_api_response_invalid",
        "The Letta messages API returned a full page without a usable pagination cursor.",
      );
    }
    after = lastId;
  }

  return messages;
}

function messagesUrl(input: LettaApiInput, after?: string): URL {
  const baseUrl = (
    input.baseUrl ??
    process.env.LETTA_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  const path = input.conversationId
    ? `/v1/conversations/${encodeURIComponent(input.conversationId)}/messages`
    : `/v1/agents/${encodeURIComponent(input.agentId as string)}/messages`;
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("order", "asc");
  if (after) url.searchParams.set("after", after);
  return url;
}

function validateInput(input: LettaApiInput): void {
  if (!input || typeof input !== "object") {
    throw new NormalizationError("invalid_input", "Input must be an object.");
  }
  if (input.source !== "letta-api") {
    throw new NormalizationError(
      "unknown_source",
      `Letta API source must be "letta-api"; received ${JSON.stringify(input.source)}.`,
    );
  }
  const hasConversation =
    typeof input.conversationId === "string" && input.conversationId.length > 0;
  const hasAgent = typeof input.agentId === "string" && input.agentId.length > 0;
  if (hasConversation === hasAgent) {
    throw new NormalizationError(
      "invalid_input",
      "Pass exactly one of conversationId or agentId.",
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
