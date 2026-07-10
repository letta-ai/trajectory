# Add a transcript source

Copy this prompt into a coding-agent session opened at the root of the
`trajectory` repository. Replace the three values before running it.

```text
Add a new transcript source to trajectory.

Source name: <SOURCE_NAME>
Transcript corpus: <ABSOLUTE_PATH_DIRECTORY_OR_GLOB>
Reference implementation: <OPTIONAL_PATH_OR_URL_OR_NONE>

The public API must remain:

  normalizeTranscript({
    source: "<SOURCE_NAME>",
    transcript: rawTranscript,
    bounds?: ...,
  })

The caller supplies both the source name and one transcript string. Do not add
store discovery, path lookup, format sniffing, network fetching, or filesystem
access to the published library.

First, read the existing source adapters, internal decoded-event contract,
normalization core, validation rules, fixtures, and tests. If a reference
implementation is provided, inspect it and treat it as the compatibility
baseline unless it violates the trajectory schema or has a documented bug.

Inspect the transcript corpus read-only and privacy-safely:

- Inventory file counts, sizes, extensions, and container formats.
- Report aggregate key signatures, event/role/type counts, and field types.
- Determine ordering, timestamp, message, reasoning, tool-call, tool-result,
  model, working-directory, and git-branch fields.
- Identify how tool results link to calls, including missing and duplicate IDs.
- Check malformed, empty, incomplete, actively written, and oversized sessions.
- Do not print transcript prose, tool arguments, tool results, credentials,
  personal paths, agent IDs, conversation IDs, or other private values.
- Do not copy a real transcript into the repository. Build small synthetic or
  thoroughly sanitized fixtures that retain only the native data shape.

Choose and document one explicit serialized input contract for the source. Use
the native single-transcript export when one exists. If the native store uses
many event files, accept a documented JSON array or export envelope as the
transcript string; locating and assembling those files remains caller work.

Implement the source as a focused adapter under src/adapters/:

- Add the source literal to TrajectorySource and register the adapter in
  src/index.ts.
- Decode native records into DecodedEvent values and SessionContext. Keep
  shared normalization, bounds, validation, and repair behavior in the core.
- Preserve meaningful prose, reasoning, tool names, structured arguments,
  results, timestamps, and stable metadata.
- Drop only source-specific transport or harness noise that is demonstrably
  irrelevant to model input.
- Preserve native tool-call IDs when possible. Create deterministic fallback
  IDs when necessary and retain enough mapping to link later results.
- Keep tool arguments as serialized JSON objects. Let the shared core reshape
  malformed or non-object arguments and apply configured bounds.
- Use diagnostics for recoverable cleanup. Throw NormalizationError only when
  the input contract is invalid or no valid trajectory can be produced.
- Keep adapter configuration as plain serializable data; do not add callbacks.

Add tests and documentation:

- Add at least one happy-path golden fixture and one cleanup/edge-case fixture.
- Cover prose, reasoning when supported, tool calls, results, ID linkage,
  timestamps, metadata, ignored transport records, and malformed input that is
  relevant to this source.
- Validate every golden output with both the runtime validator and JSON Schema.
- Add a public-API test for unrecoverable input shape when applicable.
- Document the source name and exact expected transcript container in README.md.
- Record corpus and reference-parity results in PARITY.md using aggregate counts
  only. Never include private transcript content or identifiable paths.

Validate the implementation proportionally:

- Run the entire local corpus through normalizeTranscript and report aggregate
  outcomes and diagnostic counts only.
- Detect files that change during a validation pass and exclude them from exact
  comparison.
- When a reference implementation exists, compare normalized records by hash
  first and classify mismatches without printing content. Treat configured
  policy differences separately from adapter/parser differences.
- Ensure oversized or pathological inputs terminate and remain within bounds.
- Run bun run check, a built-package Node import smoke test, npm pack --dry-run,
  git diff --check, and a credential-pattern scan before finishing.

Summarize the implemented source contract, test coverage, corpus outcomes,
intentional compatibility differences, and any unsupported native variants.
Do not commit or push unless explicitly requested.
```
