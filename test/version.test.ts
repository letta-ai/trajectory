import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CANONICAL_SCHEMA_VERSION, NORMALIZER_VERSION } from "../src/index.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

describe("runtime version constants", () => {
  test("NORMALIZER_VERSION tracks the exact published package version", () => {
    expect(NORMALIZER_VERSION).toBe(packageJson.version);
  });

  test("CANONICAL_SCHEMA_VERSION is a UInt16-safe integer", () => {
    expect(Number.isInteger(CANONICAL_SCHEMA_VERSION)).toBe(true);
    expect(CANONICAL_SCHEMA_VERSION).toBeGreaterThanOrEqual(0);
    expect(CANONICAL_SCHEMA_VERSION).toBeLessThanOrEqual(65_535);
  });
});
