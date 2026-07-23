/**
 * Compare token counts of an agent session across three representations:
 *
 *   1. native      — the session file exactly as the harness wrote it
 *   2. trajectory  — this repo's normalized JSONL (default bounds, and
 *                    optionally with tool-result truncation disabled)
 *   3. atif        — Harbor's ATIF (RFC 0001) built from the same normalized
 *                    records, serialized compact. This is a content-matched
 *                    projection: it measures ATIF *syntax* on trajectory's
 *                    content selection. Harbor's own converters additionally
 *                    keep untruncated results, structured result payloads,
 *                    and per-step metrics, so their files are much larger.
 *
 * Tokens are counted with the Anthropic count-tokens API
 * (POST /v1/messages/count_tokens), chunked at 500K characters per request.
 * Requires ANTHROPIC_API_KEY in the environment.
 *
 * Usage:
 *   bun scripts/token-efficiency.ts <session-file> [options]
 *
 *   <session-file>   Claude Code session (~/.claude/projects/<proj>/<id>.jsonl)
 *                    or Codex rollout (~/.codex/sessions/.../rollout-*.jsonl)
 *
 * Options:
 *   --source <claude-code|codex>   Override source auto-detection
 *   --model <id>                   Model for token counting (default claude-opus-4-8)
 *   --untruncated                  Also report trajectory with truncation disabled
 */

import { readFileSync } from "fs";
import { normalizeTranscript } from "../src/index.js";
import type { NormalizeInput } from "../src/index.js";

const CHUNK_CHARS = 500_000;
const API_URL = "https://api.anthropic.com/v1/messages/count_tokens";

interface CanonicalRecord {
  role: string;
  content?: string | null;
  timestamp?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; name: string; args: string }[];
  source?: string;
  model?: string;
}

function usage(): never {
  console.error(
    "usage: bun scripts/token-efficiency.ts <session-file> [--source claude-code|codex] [--model <id>] [--untruncated]",
  );
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let file: string | undefined;
  let source: string | undefined;
  let model = "claude-opus-4-8";
  let untruncated = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) usage();
    else if (a === "--source") source = args[++i] ?? usage();
    else if (a === "--model") model = args[++i] ?? usage();
    else if (a === "--untruncated") untruncated = true;
    else if (!a.startsWith("--") && file === undefined) file = a;
    else usage();
  }
  if (!file) usage();
  return { file, source, model, untruncated };
}

function detectSource(transcript: string): string {
  const firstLine = transcript.slice(0, transcript.indexOf("\n"));
  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type === "session_meta" && obj?.payload) return "codex";
  } catch {
    /* fall through */
  }
  return "claude-code";
}

/** Canonical records -> Harbor ATIF (compact JSON). */
function toAtif(records: CanonicalRecord[]): string {
  const meta = records.find((r) => r.role === "meta");
  const steps: any[] = [];
  const callOwner = new Map<string, any>();
  let pendingReasoning: string[] = [];

  const newStep = (source: string, rec: CanonicalRecord) => {
    const s: any = { step_id: steps.length + 1, source, message: rec.content ?? "" };
    if (rec.timestamp) s.timestamp = rec.timestamp;
    steps.push(s);
    return s;
  };

  for (const r of records) {
    if (r.role === "meta") continue;
    if (r.role === "user") {
      newStep("user", r);
    } else if (r.role === "reasoning") {
      pendingReasoning.push(r.content ?? "");
    } else if (r.role === "assistant") {
      const s = newStep("agent", r);
      if (pendingReasoning.length > 0) {
        s.reasoning_content = pendingReasoning.join("\n\n");
        pendingReasoning = [];
      }
      if (r.tool_calls) {
        s.tool_calls = r.tool_calls.map((tc) => {
          let args: unknown;
          try {
            args = JSON.parse(tc.args);
          } catch {
            args = { _raw: tc.args };
          }
          callOwner.set(tc.id, s);
          return { tool_call_id: tc.id, function_name: tc.name, arguments: args };
        });
      }
    } else if (r.role === "tool") {
      const owner = callOwner.get(r.tool_call_id ?? "") ?? steps.at(-1);
      if (!owner) continue;
      owner.observation ??= { results: [] };
      owner.observation.results.push({
        source_call_id: r.tool_call_id ?? null,
        content: r.content ?? "",
      });
    }
  }

  if (pendingReasoning.length > 0) {
    const tail = [...steps].reverse().find((s) => s.source === "agent");
    if (tail) {
      tail.reasoning_content = [tail.reasoning_content, ...pendingReasoning]
        .filter(Boolean)
        .join("\n\n");
    }
  }

  return JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: null,
    agent: { name: meta?.source ?? "unknown", version: "unknown", model_name: meta?.model ?? null },
    steps,
  });
}

async function countTokens(text: string, model: string, apiKey: string, label: string): Promise<number> {
  let total = 0;
  const chunkCount = Math.ceil(text.length / CHUNK_CHARS);
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    const chunk = text.slice(i, i + CHUNK_CHARS);
    let attempt = 0;
    for (;;) {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: chunk }] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { input_tokens: number };
        total += body.input_tokens;
        break;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        attempt++;
        const retryAfter = Number(res.headers.get("retry-after")) || 10 * attempt;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new Error(`count_tokens failed for ${label}: ${res.status} ${await res.text()}`);
    }
    process.stderr.write(`\r${label}: chunk ${Math.floor(i / CHUNK_CHARS) + 1}/${chunkCount} (${total.toLocaleString()} tokens)`);
  }
  process.stderr.write("\n");
  return total;
}

async function main() {
  const { file, source: sourceArg, model, untruncated } = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  const transcript = readFileSync(file, "utf8");
  const source = sourceArg ?? detectSource(transcript);
  console.error(`source: ${source} | model: ${model} | file: ${file}`);

  const normalize = (full: boolean) => {
    const input: NormalizeInput = { source, transcript } as NormalizeInput;
    if (full) {
      (input as any).bounds = {
        toolResults: { maxCharacters: null },
        toolArguments: { maxCharacters: null },
      };
    }
    const { records } = normalizeTranscript(input);
    return records as unknown as CanonicalRecord[];
  };

  const defaultRecords = normalize(false);
  const trajectoryText = defaultRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const atifText = toAtif(defaultRecords);

  const rows: { label: string; text: string }[] = [
    { label: "native", text: transcript },
    { label: "trajectory", text: trajectoryText },
    { label: "atif", text: atifText },
  ];
  if (untruncated) {
    const fullRecords = normalize(true);
    rows.push({
      label: "trajectory-untruncated",
      text: fullRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    });
  }

  const results: { label: string; bytes: number; tokens: number }[] = [];
  for (const { label, text } of rows) {
    const tokens = await countTokens(text, model, apiKey, label);
    results.push({ label, bytes: Buffer.byteLength(text), tokens });
  }

  const native = results[0]!;
  console.log(`\n${"format".padEnd(24)} ${"bytes".padStart(12)} ${"tokens".padStart(12)} ${"vs native".padStart(10)}`);
  for (const r of results) {
    const factor = r === native ? "—" : `${(native.tokens / r.tokens).toFixed(1)}x`;
    console.log(
      `${r.label.padEnd(24)} ${r.bytes.toLocaleString().padStart(12)} ${r.tokens.toLocaleString().padStart(12)} ${factor.padStart(10)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
