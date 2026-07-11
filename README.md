# trajectory

Normalize agent transcripts from different runtimes into one validated,
model-ready record format.

Agent tools represent the same concepts—messages, reasoning, tool calls, and
tool results—in incompatible native formats. `trajectory` provides one
TypeScript API that turns those formats into deterministic,
structured records for training, evaluation, analysis, and inference.

For transcript sources, the caller supplies a transcript string and its source.
The Deep Agents SDK integration instead requires an explicit LangGraph SQLite
checkpoint path and thread ID; the SDK defines no standard local store.

## Installation

Neither package has been published yet. Install the TypeScript package directly
from GitHub:

```sh
npm install github:letta-ai/trajectory
```

The Python distribution is named `letta-trajectory` and imports as
`trajectory`. It includes the bundled normalizer and has no Python runtime
dependencies, but it requires Node.js 20 or newer:

```sh
pip install "letta-trajectory @ git+ssh://git@github.com/letta-ai/trajectory.git"
```

Reading Python Deep Agents checkpoints additionally requires the optional
LangGraph dependencies (already present in a typical Deep Agents environment):

```sh
pip install "letta-trajectory[deepagents] @ git+ssh://git@github.com/letta-ai/trajectory.git"
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
| `claude-code` | Native Claude Code JSONL | `claude-code` |
| `codex` | Native Codex rollout JSONL | `codex` |
| `letta` | Cloud/API message array or local conversation JSONL (legacy and v3) | `letta` |
| `openhands` | JSON event array or an events-API `{ "items": [...] }` envelope | `openhands` |
| `deepagents` | User-supplied Python LangGraph `SqliteSaver` database plus `threadId` | `deepagents` |

Letta messages use native `message_type` values such as `user_message`,
`reasoning_message`, `assistant_message`, `tool_call_message`,
`approval_request_message`, and `tool_return_message`. The adapter orders a
complete response by `seq_id`, handles singular and batched tool fields, and
ignores system and approval-control records. It also accepts Letta's actual
local conversation files from `lc-local-backend/conversations/*/messages.jsonl`:
legacy headerless message rows and version 3 session-entry JSONL. Compaction
entries are excluded because they summarize existing conversation context.
The separate `~/.letta/transcripts` tree contains reflection artifacts and is
not a supported native input. OpenHands inputs are serialized exports; when a
native store uses individual event files, assembling the event array remains
the caller's responsibility.

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

### Deep Agents SDK checkpoints

Deep Agents conversation persistence is determined by its LangGraph
checkpointer: no checkpointer is durable, `InMemorySaver` lasts only for the
process, and `SqliteSaver` writes a caller-chosen SQLite database. There is no
SDK-wide default path, so `deepagents` is a separate source from the
`deepagents-code` CLI integration and always requires both `path` and
`threadId`.

```ts
import { normalizeCheckpoint } from "@letta-ai/trajectory";

const result = await normalizeCheckpoint({
  source: "deepagents",
  checkpoint: {
    path: "deepagents.db",
    threadId: "thread-123",
    // checkpointNamespace: "", // optional, defaults to root
    // checkpointId: "...",     // optional, defaults to latest
    // pythonExecutable: "/path/to/venv/bin/python",
  },
});
```

The TypeScript API invokes the selected Python environment because current
Python LangGraph SQLite checkpoints use serializer types that the JavaScript
`SqliteSaver` cannot deserialize. The helper calls Python LangGraph's
`SqliteSaver.get_tuple()` and DeltaChannel history APIs, then applies decoded
message writes with LangGraph's official `add_messages` reducer. It never
parses SQLite checkpoint blobs itself. The Python interpreter must contain
`langgraph` and `langgraph-checkpoint-sqlite`; pass `pythonExecutable` or set
`PYTHON` when `python3` is not the correct environment.

The Python wrapper automatically reuses its own interpreter:

```python
from trajectory import normalize_checkpoint

result = normalize_checkpoint(
    path="deepagents.db",
    thread_id="thread-123",
    checkpoint_namespace="",  # optional
    checkpoint_id=None,        # optional; latest when omitted
)
```

`loadDeepAgentsCheckpoint(location)` is also exported for integrations such as
Deep Agents Code that need to discover a location before reusing the same
decoder. `FilesystemBackend` is unrelated to this trajectory: it persists
agent-created files, not the LangGraph message/checkpoint state.

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
