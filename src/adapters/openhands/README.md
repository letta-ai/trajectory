# openhands

A serialized OpenHands event export: either a JSON event array or an
events-API `{ "items": [...] }` envelope. For a native store that keeps one
JSON file per event, `assembleOpenHandsEventFolder()` reads the `events/`
directory into the serialized array accepted by `normalizeTranscript()`.

The adapter decodes `MessageEvent` (user/agent prose), `ActionEvent` (thought
→ reasoning, tool call with native `tool_call_id` or a deterministic
`oh_<eventId>` fallback), and result events (`ObservationEvent`,
`AgentErrorEvent`, `UserRejectObservation`). A pre-pass maps action ids to
call ids so an observation arriving before its action still links instead of
being dropped as an orphan. `ObservationEvent.observation.is_error` maps to the
normalized tool result's `ok` field; other result event kinds remain unknown.
OpenHands event `id`s provide native record identity.

## Listing

`listTrajectories({ source: "openhands" })` lists conversation event
directories under `~/.openhands/conversations/<conversation-id>/events`. A
custom conversations root can be supplied with `root`. Without `root`,
`OPENHANDS_CONVERSATIONS_DIR` overrides the complete conversations path and
`OPENHANDS_PERSISTENCE_DIR` overrides the parent of `conversations`, matching
the OpenHands CLI. Directories without an `events/` child are ignored.

The returned `path` can be passed directly to the event-folder helper:

```ts
import {
  assembleOpenHandsEventFolder,
  listTrajectories,
  normalizeTranscript,
} from "@letta-ai/trajectory";

const { items } = await listTrajectories({ source: "openhands" });
const listing = items[0];
if (!listing) throw new Error("No OpenHands conversations found.");
const transcript = assembleOpenHandsEventFolder(listing.path);
const normalized = normalizeTranscript({ source: "openhands", transcript });
```

Python exposes the same helper through the bundled canonical runtime:

```py
from trajectory import (
    assemble_openhands_event_folder,
    list_trajectories,
    normalize_transcript,
)

items = list_trajectories(source="openhands")["items"]
if not items:
    raise RuntimeError("No OpenHands conversations found.")
transcript = assemble_openhands_event_folder(items[0]["path"])
normalized = normalize_transcript(source="openhands", transcript=transcript)
```

The helper orders `event-<index>-<event-id>.json` files by numeric event index
and ignores unrelated sidecars such as event-log lock and length-marker files.
Unreadable directories/files, malformed event filenames, invalid JSON, and
non-object event documents fail with an `invalid_input` normalization error.
