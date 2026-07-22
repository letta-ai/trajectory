import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("source-version audit emits aggregate structure without transcript values", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fixture = fileURLToPath(
    new URL("../fixtures/claude-code/tool-call/input.jsonl", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/audit-source-versions.ts",
      "claude-code",
      fixture,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();

  expect(await child.exited).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    source: "claude-code",
    files: 1,
  });
  expect(stdout).not.toContain("fix the flaky retry test");
  expect(stdout).not.toContain("retry.py");
  expect(stdout).not.toContain("/workspace/project");
});

test("source-version audit accepts Letta Code client transcripts", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fixture = fileURLToPath(
    new URL("../fixtures/letta-code/tool-calls/input.jsonl", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/audit-source-versions.ts",
      "letta-code",
      "--normalize",
      fixture,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();

  expect(await child.exited).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    source: "letta-code",
    files: 1,
    versions: [
      {
        version: "unknown",
        normalization: { successes: 1, errors: {} },
      },
    ],
  });
  expect(stdout).not.toContain("Inspect the entry point");
  expect(stdout).not.toContain("src/app.ts");
  expect(stdout).not.toContain("call-read-1");
});
