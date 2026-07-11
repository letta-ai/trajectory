# Parity report

> This report established parser parity before configurable bounds were added.
> The current default uses marker-inclusive, head-tail tool-result truncation
> and the canonical `claude-code` source ID. Oversized tool results and Claude
> metadata therefore intentionally differ from the production reference
> measured below. Argument normalization retains the documented behavior.

Local differential checks were run on 2026-07-10 against 1,050 on-device
sessions without retaining or printing transcript content:

- 1,006 Claude Code JSONL files
- 44 Codex rollout JSONL files

The harness compares SHA-256 hashes first. Full normalized records are written
only to a temporary directory for mismatches, classified without printing
content, and deleted when the run exits. Files that change between passes are
excluded using byte-level input hashes.

## Production TypeScript reference

Reference: `letta-agent-sdk` `dream-pipeline` commit `3d3e3e0`.

- Seven Claude sessions were confirmed to exceed a one-second isolated timeout
  in the production argument truncator. They all complete in `trajectory` and
  were excluded from the bulk reference process so it could not hang.
- All 1,043 remaining normalization outcomes matched.
- Of 903 successful sessions, 902 normalized outputs matched exactly.
- The sole record mismatch was an intentional cap repair: production returned
  a 21,560-character tool-argument object unchanged even though the documented
  cap is 20,000; `trajectory` returned a valid 19,977-character object with a
  truncation marker.

The seven timeouts and the over-cap result share one cause: the legacy
truncation loop treats 2,000 characters as a hard per-string floor. It can
repeat forever or stop above the total cap when several fields collectively
cannot fit. `trajectory` preserves the legacy output whenever it terminates
under the cap, then uses a strictly decreasing fallback otherwise.

## Letta and OpenHands adapters

The Letta adapter was checked directly against persisted message arrays
returned by the installed Letta CLI for a configured conversation, without
printing or retaining message content or identifiers. The live response
confirmed a flat array ordered by `seq_id`, block-based user content, reasoning
and assistant messages, approval request/response records, and singular fields
duplicated in batched `tool_calls` and `tool_returns` arrays. The chronological
sample normalized successfully with its native call/result linkage intact; a
newest-only slice correctly reported that it lacked a user turn.

OpenHands message, action, observation, agent-error, and user-rejection event
shapes were checked against the `dream-pipeline` OpenHands source. Both the
array and `{items: [...]}` input forms produced exact production-equivalent
records in the compatibility fixtures.

## LangSmith adapter

The LangSmith adapter is covered with synthetic runs matching the published
LangSmith Run and Messages-view formats. Fixtures exercise LangChain
constructor messages, Vercel AI SDK content blocks, repeated history snapshots,
tool-result matching by ID and tool name, run ordering, metadata, and
missing-timestamp repair.

Read-only validation was also run against two user-provided LangSmith projects
without retaining raw traces or normalized content in the repository. The
sample comprised one two-trace thread with 17 total runs (13 chain, two LLM,
and two tool runs) and one standalone LLM run. This surfaced and fixed two
native variants not present in the original synthetic fixtures: an Anthropic
SSE event stream stored in string-valued `outputs.output`, and a tool call
repeated in both content blocks and the message-level `tool_calls` field.

After those repairs, the combined thread normalized to 16 records with native
tool linkage preserved; its only diagnostic was the expected configured
tool-result truncation. The standalone LLM run normalized to three records
without diagnostics. No reference implementation was provided for differential
testing.
