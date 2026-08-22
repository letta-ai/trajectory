# Amp adapter

Pass the complete JSON object emitted by `amp threads export <thread>` as the transcript. This is an
export-only adapter: it does not execute Amp, discover local state, read files, or fetch threads.
The same envelope is used for sandbox/orb and local or web-controlled threads; executor metadata
does not select a different parser.

The root thread `id` is the source group. Message array position is source order,
`protocolMessageID` is native record identity, and content array position is component order. User
and assistant text, plaintext assistant thinking, assistant tool uses, and user tool results become
the corresponding decoded events. Structured tool result status is authoritative: `done` maps to
`ok: true`, while `error` and `cancelled` map to `ok: false`. Object-valued results are serialized as
JSON so native fields are not discarded. User send times, assistant block times, assistant usage
times/model, initial cwd, and a single repository-tree ref are preserved when present.

Amp has no session-end event. An incomplete assistant turn or block, non-terminal or missing tool
result, or unmatched final user turn therefore produces `incomplete_transcript`; it is not promoted
to a fabricated session terminal. Existing core diagnostics continue to own orphan/duplicate tool
results, duplicate call IDs, bounds, and timestamp synthesis/interpolation. Measured `info` records
are compaction/transport artifacts and are dropped with `noise_record_dropped` because the full
export retains the original messages.

Malformed or truncated JSON, missing envelope/session identity, duplicate message identity, and
unknown semantic roles or blocks fail with `invalid_input` so format drift cannot silently lose
model-visible input. Parent-thread lineage is not decoded or inferred; an external hook payload must
remain its authority.
