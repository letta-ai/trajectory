import type { Diagnostic } from "../types.js";

export interface JsonLine {
  value: Record<string, unknown>;
  line: number;
  /** UTF-8 byte offset of this line's start within the transcript. */
  byteOffset: number;
}

export function parseJsonLines(
  transcript: string,
  diagnostics: Diagnostic[],
): JsonLine[] {
  const parsed: JsonLine[] = [];
  const lines = transcript.split("\n");

  let byteOffset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    const lineByteOffset = byteOffset;
    // Advance past this line's bytes plus the "\n" separator that split removed.
    byteOffset += utf8ByteLength(raw) + 1;
    if (!raw.trim()) continue;
    const line = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "invalid_json_line",
        message: `Skipped invalid JSON on line ${line}.`,
        inputLine: line,
      });
      continue;
    }
    if (!isObject(value)) {
      diagnostics.push({
        code: "non_object_json_line",
        message: `Skipped non-object JSON on line ${line}.`,
        inputLine: line,
      });
      continue;
    }
    parsed.push({ value, line, byteOffset: lineByteOffset });
  }

  return parsed;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseTimestamp(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && value > 1e11) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    const type = item.type;
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      (type === undefined && "text" in item)
    ) {
      if (typeof item.text === "string" && item.text.length > 0) {
        parts.push(item.text);
      }
    } else if (type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

export function jsonString(value: unknown): string {
  const serialized = JSON.stringify(value ?? {});
  return serialized === undefined ? "{}" : serialized;
}
