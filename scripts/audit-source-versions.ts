import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { normalizeTranscript, NormalizationError } from "../src/index.js";

type Source = "claude-code" | "codex" | "letta-code";

interface ParsedFile {
  records: Record<string, unknown>[];
  malformedRecords: number;
  container: string;
}

interface VersionSummary {
  files: number;
  records: number;
  malformedRecords: number;
  containers: Map<string, number>;
  signatures: Map<string, number>;
  normalization: {
    successes: number;
    errors: Map<string, number>;
    diagnostics: Map<string, number>;
    roles: Map<string, number>;
  };
}

const [sourceArg, ...rawInputArgs] = process.argv.slice(2);
const runNormalization = rawInputArgs.includes("--normalize");
const inputArgs = rawInputArgs.filter((value) => value !== "--normalize");
if (!isSource(sourceArg) || inputArgs.length === 0) usage();

const files = await collectFiles(inputArgs);
const versions = new Map<string, VersionSummary>();

for (const file of files) {
  const parsed = await parseFile(file);
  const version = sourceVersion(sourceArg, parsed.records);
  const summary = versions.get(version) ?? {
    files: 0,
    records: 0,
    malformedRecords: 0,
    containers: new Map(),
    signatures: new Map(),
    normalization: {
      successes: 0,
      errors: new Map(),
      diagnostics: new Map(),
      roles: new Map(),
    },
  };

  summary.files += 1;
  summary.records += parsed.records.length;
  summary.malformedRecords += parsed.malformedRecords;
  increment(summary.containers, parsed.container);
  for (const record of parsed.records) {
    increment(summary.signatures, signature(sourceArg, record));
  }
  if (runNormalization) {
    try {
      const result = normalizeTranscript({
        source: sourceArg,
        transcript: await Bun.file(file).text(),
      });
      summary.normalization.successes += 1;
      for (const record of result.records) {
        increment(summary.normalization.roles, record.role);
      }
      for (const diagnostic of result.diagnostics) {
        increment(summary.normalization.diagnostics, diagnostic.code);
      }
    } catch (error) {
      increment(
        summary.normalization.errors,
        error instanceof NormalizationError ? error.code : "unexpected_error",
      );
    }
  }
  versions.set(version, summary);
}

const output = {
  source: sourceArg,
  files: files.length,
  privacy:
    "Aggregate structural data only; paths, transcript content, arguments, results, and identifiers are omitted.",
  versions: [...versions.entries()]
    .sort(([left], [right]) => versionCompare(left, right))
    .map(([version, summary]) => ({
      version,
      files: summary.files,
      records: summary.records,
      malformed_records: summary.malformedRecords,
      containers: mapEntries(summary.containers),
      ...(runNormalization
        ? {
            normalization: {
              successes: summary.normalization.successes,
              errors: mapEntries(summary.normalization.errors),
              diagnostics: mapEntries(summary.normalization.diagnostics),
              roles: mapEntries(summary.normalization.roles),
            },
          }
        : {}),
      signatures: [...summary.signatures.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([value, count]) => ({
          id: createHash("sha256").update(value).digest("hex").slice(0, 12),
          count,
          shape: value,
        })),
    })),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function usage(): never {
  process.stderr.write(
    "Usage: bun scripts/audit-source-versions.ts <claude-code|codex|letta-code> [--normalize] <file-or-directory> [...]\n",
  );
  process.exit(2);
}

function isSource(value: string | undefined): value is Source {
  return (
    value === "claude-code" || value === "codex" || value === "letta-code"
  );
}

async function collectFiles(inputs: string[]): Promise<string[]> {
  const collected = new Set<string>();
  for (const input of inputs) {
    const path = resolve(input);
    const info = await stat(path);
    if (info.isFile()) {
      collected.add(path);
      continue;
    }
    if (!info.isDirectory()) continue;

    const patterns =
      sourceArg === "letta-code" ? ["**/transcript.jsonl"] : ["**/*.jsonl"];
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      for await (const match of glob.scan({ cwd: path, onlyFiles: true })) {
        collected.add(resolve(path, match));
      }
    }
  }
  return [...collected].sort();
}

async function parseFile(path: string): Promise<ParsedFile> {
  if (path.endsWith(".jsonl")) return parseJsonLines(path);

  try {
    const value: unknown = await Bun.file(path).json();
    if (Array.isArray(value)) {
      return {
        records: value.filter(isObject),
        malformedRecords: value.length - value.filter(isObject).length,
        container: "json-array",
      };
    }
    if (isObject(value) && Array.isArray(value.items)) {
      return {
        records: value.items.filter(isObject),
        malformedRecords: value.items.length - value.items.filter(isObject).length,
        container: "json-items-envelope",
      };
    }
    return { records: [], malformedRecords: 1, container: "unsupported-json" };
  } catch {
    return { records: [], malformedRecords: 1, container: "invalid-json" };
  }
}

async function parseJsonLines(path: string): Promise<ParsedFile> {
  const records: Record<string, unknown>[] = [];
  let malformedRecords = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) records.push(value);
      else malformedRecords += 1;
    } catch {
      malformedRecords += 1;
    }
  }
  return { records, malformedRecords, container: "jsonl" };
}

function sourceVersion(
  source: Source,
  records: Record<string, unknown>[],
): string {
  const candidates = new Set<string>();
  for (const record of records) {
    if (source === "claude-code" && typeof record.version === "string") {
      candidates.add(record.version);
    } else if (source === "codex" && record.type === "session_meta") {
      const payload = isObject(record.payload) ? record.payload : {};
      if (typeof payload.cli_version === "string") {
        candidates.add(payload.cli_version);
      }
    }
  }
  if (candidates.size === 0) return "unknown";
  if (candidates.size === 1) return [...candidates][0] ?? "unknown";
  return `multiple:${[...candidates].sort(versionCompare).join(",")}`;
}

function signature(source: Source, record: Record<string, unknown>): string {
  if (source === "claude-code") return claudeSignature(record);
  if (source === "codex") return codexSignature(record);
  return lettaCodeSignature(record);
}

function claudeSignature(record: Record<string, unknown>): string {
  const parts = [`record:${tag(record.type)}`, `keys:${keys(record)}`];
  if (isObject(record.message)) {
    parts.push(`message.keys:${keys(record.message)}`);
    parts.push(`message.role:${tag(record.message.role)}`);
    parts.push(`message.content:${contentShape(record.message.content)}`);
  }
  return parts.join("|");
}

function codexSignature(record: Record<string, unknown>): string {
  const parts = [`record:${tag(record.type)}`, `keys:${keys(record)}`];
  if (isObject(record.payload)) {
    parts.push(`payload.type:${tag(record.payload.type)}`);
    parts.push(`payload.keys:${keys(record.payload)}`);
    if (record.payload.type === "message") {
      parts.push(`payload.role:${tag(record.payload.role)}`);
      parts.push(`payload.content:${contentShape(record.payload.content)}`);
    }
  }
  return parts.join("|");
}

function lettaCodeSignature(record: Record<string, unknown>): string {
  const parts = [`kind:${tag(record.kind)}`, `keys:${keys(record)}`];
  for (const field of [
    "text",
    "name",
    "argsText",
    "resultText",
    "resultOk",
    "captured_at",
    "source_message_id",
    "source_line_id",
  ]) {
    if (field in record) parts.push(`${field}:${valueKind(record[field])}`);
  }
  return parts.join("|");
}

function contentShape(value: unknown): string {
  if (!Array.isArray(value)) return valueKind(value);
  const blocks = new Set<string>();
  for (const block of value) {
    blocks.add(
      isObject(block)
        ? `${tag(block.type)}(${keys(block, new Set(["input"]))})`
        : valueKind(block),
    );
  }
  return `array[${[...blocks].sort().join(",")}]`;
}

function keys(
  value: Record<string, unknown>,
  excluded = new Set<string>(),
): string {
  return Object.keys(value)
    .filter((key) => !excluded.has(key))
    .sort()
    .join(",");
}

function tag(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value)
    ? value
    : valueKind(value);
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapEntries(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function versionCompare(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  if (leftParts.every(Number.isFinite) && rightParts.every(Number.isFinite)) {
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
      const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }
  return left.localeCompare(right);
}
