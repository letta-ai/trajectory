# atif

One complete [Agent Trajectory Interchange Format (ATIF)](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
JSON trajectory document. The adapter accepts schema versions `ATIF-v1.0`
through `ATIF-v1.7`; locating and reading `trajectory.json` remains the
caller's responsibility.

Root `steps` are decoded in `step_id` order. User and agent messages, agent
`reasoning_content`, tool calls, same-step observation results, timestamps,
and model metadata are preserved. System messages are available through
`filters.systemMessages: "include"` and omitted by default. Observation results
without `source_call_id` become generic `observation` records rather than being
assigned to an arbitrary tool call. `session_id` supplies run identity;
`trajectory_id` is used when a session ID is absent and also namespaces native
step identity. Canonical normalization requires `sourceContext.groupId` when
both identifiers are absent. Text content parts are joined with newlines and
image parts are represented as `[image]`, matching the other multimodal
adapters.

Embedded `subagent_trajectories` are not flattened into the parent timeline;
normalize each embedded trajectory separately when its records are needed. A
tool-linked result containing only `subagent_trajectory_ref` is retained as a
JSON string. Metrics, token IDs, logprobs, costs, notes, custom `extra` fields,
tool definitions, `is_copied_context`, `llm_call_count`, and continuation
references have no target fields and are not emitted. ATIF observation results
also have no standard success field, so normalized tool results omit `ok`.

ATIF is an exported interchange document, not a standard local agent store, so
`listTrajectories({ source: "atif" })` returns `listing_unavailable`.
