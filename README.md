# trajectory

Normalize agent transcripts from different runtimes into one validated,
model-ready record format.

Agent tools represent the same concepts—messages, reasoning, tool calls, and
tool results—in incompatible native formats. `trajectory` provides one
TypeScript API that turns those formats into deterministic,
structured records for training, evaluation, analysis, and inference.

The caller supplies a transcript string and its source. The one exception is
Deep Agents, whose sessions `normalizeCheckpoint` reads from its local
LangGraph SQLite store by thread ID; see
[`src/adapters/deepagents/`](src/adapters/deepagents/).

## Installation

The TypeScript package is published as
[`@letta-ai/trajectory`](https://www.npmjs.com/package/@letta-ai/trajectory):

```sh
npm install @letta-ai/trajectory
```

The Python distribution is named `letta-trajectory` and imports as
`trajectory`. It includes the bundled normalizer and has no Python runtime
dependencies, but it requires Node.js 20 or newer. It is not yet published to
PyPI; install it from GitHub:

```sh
pip install "letta-trajectory @ git+ssh://git@github.com/letta-ai/trajectory.git"
```

## Quick start

```ts
import { normalizeTranscript } from "@letta-ai/trajectory";

const { records, diagnostics } = normalizeTranscript({
  source: "codex",
  transcript: rawJsonl,
});
```

The Python wrapper exposes the same inputs and returns ordinary dictionaries:

```python
from trajectory import normalize_transcript

result = normalize_transcript(
    source="codex",
    transcript=raw_jsonl,
)
records = result["records"]
diagnostics = result["diagnostics"]
```

For training pipelines, `normalize_many()` sends a complete batch through one
Node process instead of starting a process for every transcript:

```python
from trajectory import normalize_many

results = normalize_many([
    {"source": "codex", "transcript": codex_jsonl},
    {"source": "letta", "transcript": letta_json},
])
```

`records` contains the normalized trajectory. `diagnostics` is always present
and is empty when the transcript required no recoverable cleanup.

```json
{
  "records": [
    { "role": "meta", "source": "codex" },
    {
      "role": "user",
      "content": "Check the current directory.",
      "timestamp": "2026-07-10T12:00:00.000Z"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_1",
          "name": "exec_command",
          "args": "{\"cmd\":\"pwd\"}"
        }
      ],
      "timestamp": "2026-07-10T12:00:01.000Z"
    },
    {
      "role": "tool",
      "tool_call_id": "call_1",
      "content": "/workspace",
      "timestamp": "2026-07-10T12:00:02.000Z"
    }
  ],
  "diagnostics": []
}
```

## Supported sources

| `source` | Accepted input format | Normalized `meta.source` |
| --- | --- | --- |
| [`claude-code`](src/adapters/claude-code/) | Native Claude Code JSONL | `claude-code` |
| [`codex`](src/adapters/codex/) | Native Codex rollout JSONL | `codex` |
| [`hermes`](src/adapters/hermes/) | Session-store message-row array or a `{ "session": {...}, "messages": [...] }` envelope | `hermes` |
| [`letta`](src/adapters/letta/) | Cloud/API message array or local conversation JSONL (legacy and v3) | `letta` |
| [`openclaw`](src/adapters/openclaw/) | Native OpenClaw session JSONL (pi-agent session format) | `openclaw` |
| [`openhands`](src/adapters/openhands/) | JSON event array or an events-API `{ "items": [...] }` envelope | `openhands` |
| [`deepagents`](src/adapters/deepagents/) | Deep Agents CLI LangGraph SQLite store plus `threadId` | `deepagents` |

Each adapter lives in its own folder under [`src/adapters/`](src/adapters/)
with a README documenting the exact input contract, decoding behavior, and
what the adapter drops.

## Listing local trajectories

`listTrajectories()` enumerates the sessions in a source's standard local
store, newest first, with cursor pagination. It is a discovery layer beside
normalization — `normalizeTranscript()` itself never touches the filesystem.

```ts
import { listTrajectories } from "@letta-ai/trajectory";

let cursor: string | undefined;
do {
  const page = await listTrajectories({ source: "claude-code", limit: 100, cursor });
  for (const item of page.items) {
    // item.id, item.path, item.updatedAt?, item.title?, item.sizeBytes?
  }
  cursor = page.nextCursor;
} while (cursor);
```

The Python wrapper mirrors it as `list_trajectories(source=..., root=None,
cursor=None, limit=None)`.

Each item's `path` is the locator for the next step: the transcript file to
read (`claude-code`, `codex`, `letta`, `openclaw`), the SQLite store holding
the session (`hermes`, `deepagents` — feed the item's `id` to the export
query or `normalizeCheckpoint`), or the session's event directory
(`openhands`). Every adapter README documents its default store location;
`root` overrides it, and a missing store yields an empty listing. Listing the
SQLite-backed sources requires a runtime with built-in SQLite (Node.js 22.5+
or Bun). Pagination is positional over a newest-first snapshot and degrades
gracefully when the store changes between pages.

## Normalized records

A trajectory is an ordered array containing:

- One leading `meta` record identifying the source and available session
  metadata.
- `user` and assistant prose records.
- Optional `reasoning` records when the source exposes reasoning.
- Assistant tool-call records with stable IDs and stringified JSON-object
  arguments.
- `tool` records linked to earlier calls by `tool_call_id`.

Every conversational record has an ISO timestamp. The complete contract is
available as both runtime validation and
[`schema/trajectory-v1.schema.json`](schema/trajectory-v1.schema.json).

The public function is:

```ts
normalizeTranscript(input: NormalizeInput): NormalizeResult
```

An unknown source, an invalid source-level container, or a transcript that
cannot form a valid trajectory throws `NormalizationError`. Recoverable
conditions—such as malformed JSONL lines, orphaned tool results, duplicate call
IDs, truncated content, or synthesized timestamps—are returned as structured
diagnostics.

## Bounds

Tool payload bounds are optional and use compatibility-preserving defaults:

```ts
const result = normalizeTranscript({
  source: "claude-code",
  transcript: rawJsonl,
  bounds: {
    toolArguments: { maxCharacters: 20_000 },
    toolResults: {
      maxCharacters: 2_500,
      strategy: "head-tail",
    },
  },
});
```

Bounds are measured in Unicode code points, and the truncation marker counts
toward the configured maximum. Oversized tool arguments are shortened while
remaining valid JSON objects. Tool results support:

- `"head-tail"` (default), which preserves roughly equal portions of the
  beginning and end.
- `"head"`, which preserves only the beginning.

Set an individual `maxCharacters` to `null` to disable that bound. Omitted
fields use the exported `DEFAULT_NORMALIZATION_BOUNDS` values.

## Canonical records for ingestion

`normalizeToCanonical()` returns an additive, ingestion-ready view for the Cloud
normalizer worker, carrying source-native identity, logical ordering, and
content hashing alongside the trajectory-v1 record. `normalizeTranscript()` and
its output are unchanged.

```ts
import {
  normalizeToCanonical,
  NORMALIZER_VERSION,
  CANONICAL_SCHEMA_VERSION,
} from "@letta-ai/trajectory";

const { records } = normalizeToCanonical({ source: "claude-code", transcript: rawJsonl });
```

`NORMALIZER_VERSION` (the exact package version) and `CANONICAL_SCHEMA_VERSION`
are exported runtime constants recorded on every canonical row. See
[`CANONICAL.md`](CANONICAL.md) for the full field contract, identity model,
determinism guarantees, and the worker-side responsibilities. The canonical
JSON Schema is published as
[`schema/trajectory-canonical-v1.schema.json`](schema/trajectory-canonical-v1.schema.json).

## Adding a source

Each native format is implemented as a focused adapter that decodes source
events into the shared internal message/tool contract. Common validation,
linking, repair, timestamp handling, and bounds remain in the normalization
core.

Use [`prompts/add-source.md`](prompts/add-source.md) with a coding agent to add
a source from a local transcript corpus. The prompt covers privacy-safe corpus
inspection, sanitized fixtures, compatibility checks, and the transcript-only
API boundary.

## Development

Requires Node.js 20+ and [Bun](https://bun.sh/) for development:

```sh
bun install
bun run check
```

`bun run check` runs typechecking, the complete test suite, and the package
build. It also regenerates the JavaScript runtime embedded in the Python wheel
and fails if the committed bundle was stale. Run the Python parity suite with:

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
```

See [`PARITY.md`](PARITY.md) for compatibility checks performed against real
transcript corpora and production source adapters.
See [`SOURCE_VERSION_AUDIT.md`](SOURCE_VERSION_AUDIT.md) for the privacy-safe
source-version inventory, observed format families, and current decoder gaps.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
