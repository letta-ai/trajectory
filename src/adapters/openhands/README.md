# openhands

A serialized OpenHands event export: either a JSON event array or an
events-API `{ "items": [...] }` envelope. When a native store keeps individual
event files, assembling the event array remains the caller's responsibility.

The adapter decodes `MessageEvent` (user/agent prose), `ActionEvent` (thought
→ reasoning, tool call with native `tool_call_id` or a deterministic
`oh_<eventId>` fallback), and result events (`ObservationEvent`,
`AgentErrorEvent`, `UserRejectObservation`). A pre-pass maps action ids to
call ids so an observation arriving before its action still links instead of
being dropped as an orphan. `ObservationEvent.observation.is_error` maps to the
normalized tool result's `ok` field; other result event kinds remain unknown.
OpenHands event `id`s provide native record identity.

## Listing

`listTrajectories({ source: "openhands" })` lists the session directories
under `~/.openhands/sessions`; assembling a directory's event files into the
transcript array remains the caller's step.
