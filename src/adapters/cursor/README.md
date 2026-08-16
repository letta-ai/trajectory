# cursor

The adapter accepts the Cursor capture JSONL used by SWE-chat. Each line is:

```json
{ "role": "user | assistant", "message": { "content": [] } }
```

Content may also be a scalar string. `text`, `thinking`, `tool_use`, and
`tool_result` blocks become prose, reasoning, tool calls, and linked results.
Tool arguments remain structured JSON. When present, block call IDs and
`is_error` are preserved.

The observed SWE-chat Cursor capture omits timestamps, top-level record IDs,
tool-call IDs, and tool results. In that native subset the shared core
synthesizes deterministic timestamps and call IDs, while canonical source
identity anchors to each JSONL row's UTF-8 byte offset. The adapter also accepts
the same content-block shape when IDs or results are present.

The transcript bytes have no session, kind, or parent identifier. SWE-chat
captures with no locator stay as today: no `kind` / `parent_id`, and callers
using `normalizeToCanonical()` must pass the corpus/session ID as
`sourceContext.groupId`. Trajectory-v1 `normalizeTranscript()` needs no extra
context for those exports.

Malformed JSONL lines and unknown rows or content-block types are recoverable
diagnostics.

## Local store

Cursor writes agent transcripts under
`~/.cursor/projects/<slug>/agent-transcripts/`:

```
<parent-uuid>/<parent-uuid>.jsonl
<parent-uuid>/subagents/<child-uuid>.jsonl
```

Kind and parent live entirely in that path. `listTrajectories({ source: "cursor" })`
enumerates both parents and `subagents/` children. Listing `id` is the file
stem. The same uuid can appear under more than one project folder (a window
moved); listing collapses those to the newest file so pagination-by-id stays
well-defined.

`normalizeTranscript()` never reads a path. Pass the listing `path` as
`sourceContext.locator` so the adapter can parse identity from path segments
(POSIX and Windows):

```ts
import { readFile } from "node:fs/promises";
import { listTrajectories, normalizeTranscript } from "@letta-ai/trajectory";

const page = await listTrajectories({ source: "cursor" });
for (const item of page.items) {
  const transcript = await readFile(item.path, "utf8");
  normalizeTranscript({
    source: "cursor",
    transcript,
    sourceContext: { locator: item.path },
  });
}
```

A locator whose path contains a `subagents` segment sets `kind: "subagent"` and
`parent_id` to the directory immediately above it. The file stem becomes
`sourceGroupId`, so local canonical calls do not need a separate `groupId`.
A parent locator sets `sourceGroupId` from the stem and omits kind.
