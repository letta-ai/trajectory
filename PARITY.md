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

## Letta Code and OpenHands adapters

The Letta Code adapter was checked on 2026-07-22 against the complete local
`~/.letta/transcripts` tree without printing or retaining transcript content,
tool payloads, paths, or identifiers. This is the append-only client-side
`transcript.jsonl` used for reflection slicing and payload generation, not a
backend conversation-history store.

- The store contained 1,924 transcript files: 274 nonempty logs and 1,650
  empty logs. The nonempty logs contained 37,243 valid JSONL rows.
- All 274 nonempty logs normalized successfully. Empty logs correctly failed
  with `invalid_input` and are omitted by `listTrajectories()`.
- The corpus exercised `user`, `assistant`, `reasoning`, and `tool_call` rows,
  including older rows without source ids, failed tool results, and unfinished
  calls. All 21,991 completed tool rows normalized as linked call/result pairs;
  no orphan-result or synthesized-call-id diagnostics remained.
- Canonical replay assigned row-position identities to 17,104 records emitted
  from historical id-less rows, with no duplicate record ids within a log.
- Sanitized fixtures cover source-message versus source-line identity,
  reasoning/assistant components from one source message, completed and
  unfinished tools, failed results, malformed lines, error rows, unsupported
  row kinds, and row-position identity for older rows without source ids.

OpenHands message, action, observation, agent-error, and user-rejection event
shapes were checked against the `dream-pipeline` OpenHands source. Both the
array and `{items: [...]}` input forms produced exact production-equivalent
records in the compatibility fixtures.

## Hermes adapter

The Hermes adapter was checked on 2026-07-22 against the complete local
`~/.hermes/state.db` session store (7 sessions, 22 active message rows) without
printing or retaining message content. Each session was exported as the
documented `{session, messages}` envelope and normalized through both
`normalizeTranscript` and `normalizeToCanonical`:

- 6 of 7 sessions normalized cleanly with zero diagnostics (34 records).
- The remaining session contained only unanswered user messages and correctly
  failed strict validation with `missing_assistant_records`.
- The corpus confirmed epoch-second `time.time()` timestamps, string content
  rows, and duplicated `reasoning`/`reasoning_content` fields on reasoning
  turns.

The local corpus contained no tool-call rows, so tool-call decoding (OpenAI
Chat Completions dicts including Codex Responses `call_id` extras, the
simplified id-less `{name, arguments}` flush shape, JSON-string versus decoded
`tool_calls` columns, and the `\x00json:` multimodal content sentinel) was
implemented against the `hermes-agent` reference implementation
(`hermes_state.py` `append_message`/`get_messages` and the `run_agent.py`
session-flush path) and is covered by sanitized fixtures.

## OpenClaw adapter

The local OpenClaw session store (`agents/main/sessions`) was empty on this
machine, so the adapter was implemented against the `openclaw` reference
implementation as the compatibility baseline: the pi-coding-agent
`SessionManager` JSONL contract used by `config/sessions/transcript.ts`
(header + wrapper-row append), the `type: "message"`-only filtering used by
`memory/session-files.ts` and the TUI history loader, the
`{role: "toolResult", toolCallId, toolName, content, isError}` result shape,
`{type: "toolCall", id, name, arguments}` assistant blocks, and the
`delivery-mirror` placeholder model written by the assistant delivery mirror
(kept as prose, excluded from model metadata). Malformed JSONL lines are
recoverable diagnostics, mirroring OpenClaw's own session-file repair, which
drops them. Wrapper entry ids provide native canonical identity; rows without
ids anchor to the append-only byte offset. Sanitized fixtures cover the happy
path and the cleanup cases; no real transcript content was available or used.

## OMP (Oh My Pi) adapter

OMP is a fork of pi-mono and shares its SessionManager JSONL lineage, so the
`omp` adapter reuses the pi/openclaw shared decoder with the `omp` source
label and no model exclusions. The adapter was checked on 2026-07-24 against
the complete local `~/.omp/agent/sessions` primary-session tree (one level
under each escaped-cwd project directory) without printing or retaining
transcript content, tool payloads, paths, or identifiers:

- 363 primary session JSONL files were enumerated.
- 346 normalized successfully (116,056 records). 17 failed strict validation
  as expected — 12 `missing_user_records` and 5 `missing_assistant_records`
  from sessions containing only one conversational role.
- Diagnostics on successful sessions were exclusively default-bounds
  truncations (`tool_result_truncated`, `tool_arguments_truncated`); no
  `invalid_json_line`, `orphan_tool_result`, `duplicate_tool_call_id`, or
  `tool_call_id_synthesized` diagnostics appeared, confirming clean native
  tool-call↔result linkage and well-formed JSONL.
- The corpus exercised the v3 `{type:"session"}` header (`cwd`, no
  `git_branch`) and OMP-only entry types (`session_init`, `title`,
  `service_tier_change`, `mode_change`, `ttsr_injection`, and
  `custom`/`custom_message` rows), all silently dropped by the shared
  `type !== "message"` filter. Message roles were `user`, `assistant`, and
  `toolResult`; content blocks were `text`, `thinking`, and `toolCall`.

Sanitized synthetic fixtures cover the happy path (reasoning, linked tool
calls and results, model metadata) and cleanup (malformed line, orphan tool
result, failed/error result, skipped `bashExecution` role, image block,
OMP-only dropped entry types). No real transcript content was retained.

## Deep Agents SDK checkpoints

The `deepagents` fixture is generated by Python
`langgraph-checkpoint-sqlite` through `SqliteSaver.put()` and `put_writes()`.
An additional hermetic integration test runs `deepagents.create_deep_agent()`
with a deterministic tool-capable model and normalizes the SDK-created SQLite
checkpoint, so CI covers the actual SDK persistence contract without an API key.
It contains canonical `HumanMessage`, `AIMessage` reasoning/text/tool calls,
`ToolMessage`, model/cwd metadata, an ancestor checkpoint with message writes,
and a selected checkpoint with pending message writes. The fixture mirrors the
Deep Agents CLI store layout (`~/.deepagents/sessions.db`): multiple threads,
all in the root checkpoint namespace, with the latest checkpoint selected per
thread. Tests cover per-thread isolation and LangGraph Overwrite semantics.

A Python-generated fixture was also opened with the official JavaScript
`@langchain/langgraph-checkpoint-sqlite` saver as an interoperability gate. The
JavaScript saver rejected Python's `msgpack` serializer type. The production
adapter therefore delegates to the official Python saver and message reducer
instead of decoding SQLite blobs or assuming cross-language wire compatibility.

## OpenCode native export

The OpenCode adapter was implemented against the native-format parser in
`letta-train` and a privacy-safe structural audit of public
`SALT-NLP/SWE-chat` raw transcripts. The corpus contained 623 `OpenCode` rows
plus one lowercase `opencode` row. The audit inspected aggregate keys, field
types, part/status values, and file sizes without retaining transcript content,
arguments, results, paths, or identifiers.

Native documents consistently used `{info, messages[].parts[]}`. Sampled tool
states included `completed`, `error`, and one unfinished `running` call. Part
IDs, call IDs, millisecond times, model, cwd, output, and string errors are
preserved. Of 17 native documents in the matched sample, 16 normalized
successfully (5,380 records); one valid but incomplete user-only session
correctly failed with `missing_assistant_records`.

Sanitized happy-path and cleanup fixtures cover reasoning, linked calls and
results, terminal status, metadata, unknown semantic records, and canonical
native identity. No source transcript content was copied into this repository.
