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

## Quick start

```ts
import { normalizeTranscript } from "@letta-ai/trajectory";

const { records, diagnostics } = normalizeTranscript({
  source: "codex",
  transcript: rawJsonl,
});
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
| [`cursor`](src/adapters/cursor/) | Cursor role/message content-block JSONL capture | `cursor` |
| [`droid`](src/adapters/droid/) | Native Droid session JSONL | `droid` |
| [`gemini-cli`](src/adapters/gemini-cli/) | Native Gemini CLI whole-session JSON | `gemini-cli` |
| [`hermes`](src/adapters/hermes/) | Session-store message-row array or a `{ "session": {...}, "messages": [...] }` envelope | `hermes` |
| [`letta-code`](src/adapters/letta-code/) | Letta Code client `transcript.jsonl` | `letta-code` |
| [`omp`](src/adapters/omp/) | Native OMP (Oh My Pi) coding-agent session JSONL (pi-agent session format) | `omp` |
| [`openclaw`](src/adapters/openclaw/) | Native OpenClaw session JSONL (pi-agent session format) | `openclaw` |
| [`opencode`](src/adapters/opencode/) | Native OpenCode `{ "info": ..., "messages": [...] }` session JSON | `opencode` |
| [`openhands`](src/adapters/openhands/) | JSON event array or an events-API `{ "items": [...] }` envelope | `openhands` |
| [`pi`](src/adapters/pi/) | Native pi-coding-agent session JSONL | `pi` |
| [`deepagents`](src/adapters/deepagents/) | Deep Agents CLI LangGraph SQLite store plus `threadId` | `deepagents` |

Tool result records may include `ok: boolean` when the source exposes an
authoritative structured outcome, such as Pi/OpenClaw `isError`, Claude Code
`is_error`, Letta Code `resultOk`, OpenHands/Cursor `is_error`, or
OpenCode/Gemini terminal state. The field is omitted when the source does not
expose a reliable status; result text is never interpreted as success or
failure.

Each adapter lives in its own folder under [`src/adapters/`](src/adapters/)
with a README documenting the exact input contract, decoding behavior, and
what the adapter drops.

## Listing local trajectories

`listTrajectories()` enumerates the sessions in a source's standard local
store, newest first, with cursor pagination. It is a discovery layer beside
normalization — `normalizeTranscript()` itself never touches the filesystem.
Cursor, Gemini CLI, and OpenCode are export-only input contracts and
intentionally return `listing_unavailable`; callers locate and read the
exports themselves.

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
