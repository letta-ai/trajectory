# trajectory

Normalize agent transcripts from different runtimes into one validated,
model-ready record format.

Agent tools represent the same concepts—messages, reasoning, tool calls, and
tool results—in incompatible native formats. `trajectory` provides one
synchronous TypeScript API that turns those formats into deterministic,
structured records for training, evaluation, analysis, and inference.

The caller supplies a transcript string and its source. The library does not
discover local sessions, read transcript stores, or guess formats.

## Installation

The npm package has not been published yet. Install the current repository
directly from GitHub:

```sh
npm install github:letta-ai/trajectory
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
| `claude-code` | Native Claude Code JSONL | `claude-code` |
| `codex` | Native Codex rollout JSONL | `codex` |
| `letta` | Native Letta transcript JSON | `letta` |
| `openhands` | JSON event array or an events-API `{ "items": [...] }` envelope | `openhands` |

Letta messages use native `message_type` values such as `user_message`,
`reasoning_message`, `assistant_message`, `tool_call_message`,
`approval_request_message`, and `tool_return_message`. The adapter orders a
complete response by `seq_id`, handles singular and batched tool fields, and
ignores system and approval-control records. OpenHands inputs are serialized
exports; when a native store uses individual event files, assembling the event
array remains the caller's responsibility.

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
build. See [`PARITY.md`](PARITY.md) for compatibility checks performed against
real transcript corpora and production source adapters.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
