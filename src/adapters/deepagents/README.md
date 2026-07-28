# deepagents

Deep Agents has no transcript format: all conversation persistence goes
through a LangGraph checkpointer, so the on-disk data is checkpoint state, not
messages. The one standard local store is the Deep Agents CLI database at
`~/.deepagents/sessions.db`, where every session is a thread in the root
checkpoint namespace. `normalizeCheckpoint` reads that store by default and
normalizes the latest state of one thread; pass `path` only for a non-default
store (for example an SDK application's own `SqliteSaver` database, whose
threads must live in the root namespace).

```ts
import { normalizeCheckpoint } from "@letta-ai/trajectory";

const result = await normalizeCheckpoint({
  source: "deepagents",
  checkpoint: {
    threadId: "abc12345", // as listed by the CLI session picker
    // path: "custom/sessions.db",              // optional store override
    // pythonExecutable: "/path/to/venv/python", // optional interpreter
  },
});
```

Decoding delegates to the installed Python LangGraph packages (Python
checkpoint serialization is not readable from JavaScript), so the selected
interpreter must contain `langgraph` and `langgraph-checkpoint-sqlite` — both
already present in a typical Deep Agents environment. Pass `pythonExecutable`
or set `PYTHON` when `python3` is not the right environment. The Python
wrapper reuses its own interpreter automatically, and its optional extra
installs the LangGraph dependencies:

```sh
pip install "agent-trajectory[deepagents]"
```

```python
from trajectory import normalize_checkpoint

result = normalize_checkpoint(
    thread_id="abc12345",
    # path="custom/sessions.db",  # optional; defaults to ~/.deepagents/sessions.db
)
```

`normalizeCheckpointToCanonical()` provides the canonical ingestion view, and
`loadDeepAgentsCheckpoint()` exposes the decoded checkpoint data directly. The
canonical group identity encodes the `(threadId, checkpointNamespace)` pair;
see [`CANONICAL.md`](../../../CANONICAL.md).

## Listing

`listTrajectories({ source: "deepagents" })` lists the distinct root-namespace
threads in `~/.deepagents/sessions.db`, newest first by latest checkpoint id;
feed an item's `id` to `normalizeCheckpoint` as `threadId`.
