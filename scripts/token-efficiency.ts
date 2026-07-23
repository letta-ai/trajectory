/**
 * Compare token counts of an agent session across three representations:
 *
 *   1. native      — the session file exactly as the harness wrote it
 *   2. trajectory  — this repo's normalized JSONL (default bounds, and
 *                    optionally with tool-result truncation disabled)
 *   3. atif        — Harbor ATIF (RFC 0001) produced by Harbor's own
 *                    converters (`ClaudeCode`/`Codex`._convert_events_to_trajectory),
 *                    driven by scripts/harbor_atif_convert.py. Reported both
 *                    minified and as Harbor persists it (indent=2). Note
 *                    Harbor's converters keep untruncated tool results,
 *                    structured result payloads, and per-step metrics, so
 *                    ATIF carries more content than trajectory by design.
 *
 * Tokens are counted with the Anthropic count-tokens API
 * (POST /v1/messages/count_tokens), chunked at 500K characters per request.
 * Requires ANTHROPIC_API_KEY in the environment, plus `uv` and `git` on PATH
 * (a harbor checkout is cloned to ~/.cache/trajectory/harbor-repo on first
 * use; override with HARBOR_REPO=<path>).
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

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
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

const HARBOR_GIT_URL = "https://github.com/harbor-framework/harbor.git";

function ensureHarborCheckout(): string {
  const repo = process.env.HARBOR_REPO ?? join(homedir(), ".cache", "trajectory", "harbor-repo");
  if (existsSync(join(repo, "src", "harbor"))) return repo;
  if (process.env.HARBOR_REPO) {
    console.error(`HARBOR_REPO=${repo} is not a harbor checkout`);
    process.exit(1);
  }
  console.error(`cloning harbor into ${repo} ...`);
  mkdirSync(dirname(repo), { recursive: true });
  const clone = spawnSync("git", ["clone", "--depth", "1", HARBOR_GIT_URL, repo], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (clone.status !== 0) {
    console.error("git clone of harbor failed");
    process.exit(1);
  }
  return repo;
}

/** Run Harbor's own converter via scripts/harbor_atif_convert.py. */
function harborAtif(sessionFile: string, source: string): { compact: string; pretty: string } {
  const harborRepo = ensureHarborCheckout();
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const outDir = mkdtempSync(join(tmpdir(), "harbor-atif-"));
  const out = join(outDir, "atif.min.json");
  const outPretty = join(outDir, "atif.json");
  try {
    const run = spawnSync(
      "uv",
      [
        "run",
        "--no-project",
        "--python",
        "3.12",
        "--with",
        "pydantic",
        join(scriptsDir, "harbor_atif_convert.py"),
        sessionFile,
        "--source",
        source,
        "--harbor",
        harborRepo,
        "--out",
        out,
        "--out-pretty",
        outPretty,
      ],
      { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
    );
    if (run.status !== 0) {
      console.error("harbor conversion failed (is `uv` installed?)");
      process.exit(1);
    }
    return { compact: readFileSync(out, "utf8"), pretty: readFileSync(outPretty, "utf8") };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
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
  const atif = harborAtif(file, source);

  const rows: { label: string; text: string }[] = [
    { label: "native", text: transcript },
    { label: "trajectory", text: trajectoryText },
    { label: "atif (harbor, minified)", text: atif.compact },
    { label: "atif (harbor, persisted)", text: atif.pretty },
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
