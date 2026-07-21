# Canonical records

`normalizeToCanonical()` (and `normalizeCheckpointToCanonical()`) return
ingestion-ready **canonical records** for the Cloud normalizer worker. This is
an additive view: `normalizeTranscript()` and its trajectory-v1 `records` output
are unchanged, and the trajectory-v1 JSON Schema
([`schema/trajectory-v1.schema.json`](schema/trajectory-v1.schema.json)) still
describes that output. The canonical view is described by
[`schema/trajectory-canonical-v1.schema.json`](schema/trajectory-canonical-v1.schema.json).

```ts
import { normalizeToCanonical, NORMALIZER_VERSION, CANONICAL_SCHEMA_VERSION } from "@letta-ai/trajectory";

const { records, diagnostics, normalizer_version, canonical_schema_version, config } =
  normalizeToCanonical({ source: "claude-code", transcript: rawJsonl });
```

## Runtime version constants

- `NORMALIZER_VERSION` (string) — the exact published npm version of this
  package. Runtime provenance for the deployed normalizer artifact. The worker
  records it as `normalizer_version` on every row and pins this npm version.
- `CANONICAL_SCHEMA_VERSION` (number, UInt16-safe) — versions the canonical
  contract (field set and semantics). Bumped manually only when the canonical
  contract changes, independent of packaging-only releases. The worker records
  it as `schema_version`.

## Field ownership split

The library owns source-native and canonical-record fields. The Cloud
normalizer worker owns tenancy, raw-upload lineage, ingestion identity, and the
fields it must compute from stored cross-upload state.

| Field | Owner | Notes |
| --- | --- | --- |
| `source_type` | library value, worker writes | e.g. `claude-code` |
| `source_group_id` | library | native session/conversation id, else the sentinel `default` (scoped by `source_id` in Cloud) |
| `stable_source_record_id` | library | stable across re-runs and transport-arrival order; never content-derived except the explicit `content` fallback |
| `source_identity_kind` | library | `native` \| `location` \| `content` \| `synthetic` — how identity was derived (see below). **Requires a `source_identity_kind LowCardinality(String)` column in ClickHouse.** |
| `source_order_id` | library | fixed-width, lexicographically sortable logical order key within the group |
| `component_index` | library | index within one source record; worker sort input, **not** a ClickHouse column |
| `record_type` | library | `meta` \| `user` \| `reasoning` \| `assistant` \| `assistant-tool-call` \| `tool` |
| `record_id` | library | per-canonical-record dedup identity (64-hex sha256) |
| `record_hash` | library | sha256 of `record_json` (64-hex) |
| `content_hash` | library | sha256 of canonical semantic content, excluding transport metadata/timestamps (64-hex) |
| `source_timestamp`, `record_timestamp` | library | descriptive only, never a cursor; nullable |
| `content`, `tool_call_id`, `tool_name`, `tool_arguments_json`, `tool_result_json` | library | nullable flattened fields |
| `record_json` | library | lossless canonical JSON of the emitted trajectory-v1 record |
| `organization_id`, `workspace_id`, `user_id`, `source_id`, `source_upload_id` | worker | tenancy + raw-upload lineage |
| `ingestion_id`, `ingested_at` | worker | opaque monotonic ingestion identity — the Dream cursor key |
| `content_version` | worker | assigned from stored cross-upload state (see below) |
| `record_index` | worker | authoritative ClickHouse index, assigned after sorting |
| `normalizer_version`, `schema_version`, `config_hash` | worker | versions come from the exports above; `config_hash` from `config.bounds` |

## Source context for chunked uploads

`normalizeToCanonical()` accepts an optional `sourceContext` so the worker can
anchor identity absolutely across chunked uploads of one append-only source
generation:

```ts
normalizeToCanonical({ source, transcript, sourceContext: { groupId, baseByteOffset } });
```

- `groupId` — the authoritative logical source group/session. It **fills** a
  missing adapter-detected group (for example a Codex chunk uploaded without its
  `session_meta`). If an adapter-detected group and `groupId` are both present
  and disagree, normalization fails with `source_group_conflict` so the upload
  can be quarantined.
- `baseByteOffset` — the absolute UTF-8 byte offset of this transcript within its
  source generation. It is added only to **byte-anchored** location identities
  (Codex, and local Letta rows without a native id), making them stable
  regardless of chunk boundaries. Ordinal anchors (Deep Agents) ignore it, and the
  anchor unit is part of the identity so byte and ordinal anchors never collide.

Codex is `location`-anchored and therefore **requires** a resolved group
(detected `session_meta` or `sourceContext.groupId`); it fails with
`source_group_required` rather than falling back to the `default` sentinel, which
would turn missing context into durable bad identity. Absolute byte offsets are
only stable within one append-only generation; a truncation/replacement is a new
generation upstream (worker-owned).

A non-zero `baseByteOffset` marks a **continuation chunk** — one slice of a
larger conversation — and `normalizeToCanonical` switches to partial-transcript
semantics for it (while `normalizeTranscript()` stays strict):

- The meta record is emitted only for the initial byte range
  (`baseByteOffset === 0` or absent). A continuation omits meta: its meta would
  share the group's constant meta identity but carry different session context,
  which would look like a false conflicting-version. If the initial range never
  arrives, missing meta is preferable to a false conflict.
- Whole-conversation invariants are relaxed: a continuation is not required to
  contain a user and an assistant turn, so single-role chunks are accepted.
- A tool result whose call lived in an earlier chunk is kept and linked by its
  source call id (not dropped as an orphan); the worker resolves cross-chunk
  linkage. A duplicate result (call present and already consumed) is still
  dropped.

`normalizeTranscript()` always requires a user and an assistant turn, drops
orphan/cross-chunk tool results, and includes meta.

Deep Agents checkpoint identity is grouped by the `(threadId, checkpointNamespace)`
pair, encoded uniformly for every namespace (including root) as
`JSON.stringify([threadId, checkpointNamespace])`, so distinct threads and
namespaces never collide — even when a thread id literally looks like the
encoding.

## Identity model

Identity is derived only from source-native signals — never from content or
transport-arrival position — so it is stable across re-runs and across the order
the worker coalesces upload chunks. `source_identity_kind` tells the worker how
confidently it can interpret conflicts:

- `native` — a source-native per-record id (Claude Code line `uuid`, Letta
  message `id`, OpenHands event `id`). Supports exact-duplicate dedup **and**
  conflicting-version detection.
- `location` — a stable source-native location anchor when no native id exists:
  an absolute UTF-8 byte offset for Codex and local Letta (chunkable via
  `baseByteOffset`), a whole-decode ordinal for Deep Agents, or a Letta `seq_id`.
  The anchor unit is part of the identity, so byte and ordinal anchors never
  collide. Supports dedup and conflict detection for append-only assembly.
- `content` — content-addressed fallback when neither a native id nor a stable
  location exists. Supports exact-duplicate dedup **only**; it cannot detect a
  conflicting version of the same logical record.
- `synthetic` — the deterministic identity generated for the leading `meta`
  record.

`record_id = sha256([source_group_id, stable_source_record_id, componentKey])`,
where `componentKey` is a semantic key: `meta`, `tool-call:<tool_call_id>`,
`tool-result:<tool_call_id>`, or `message:<n>` / `reasoning:<n>`. Tool
calls/results use their native `tool_call_id`. Messages and reasoning can repeat
within one source record without a native id, so they always carry a type-local
ordinal (`message:0` even when there is only one) — the ordinal is present from
the start so a conflicting version that changes cardinality (one reasoning block
becomes two) does not shift the original record's `record_id`. Keeping the key
semantic (rather than a global component index) means inserting an unrelated
component does not shift the surrounding records' `record_id`, so the worker can
still recognize a conflicting version of the same logical record. Each
occurrence of the same source record produces identical component keys, so exact
duplicates collapse to the same `record_id`. `component_index` is retained only
as worker sort input.

## Worker responsibilities (LET-9827 handoff)

- **Dedup by `(source_id, record_id)`** — not `(source_upload_id, record_id)`.
  `source_upload_id` records lineage and protects upload retries; it is not the
  logical-record dedup scope. An appended-transcript upload that re-sends
  earlier records must not reinsert them.
- **Order** by `(source_order_id, component_index)`, then assign the
  authoritative ClickHouse `record_index` (UInt32). The library preserves
  emitted order; it does not promise a final ClickHouse index.
- **`content_version`** — assign `1` for the first accepted identity, treat the
  same identity + same `content_hash` as a duplicate, and increment or quarantine
  when the same identity has a conflicting `content_hash` (only trustworthy for
  `native`/`location` identity kinds).
- **`config_hash`** — hash a canonical serialization of the effective
  configuration, including `config.bounds` from the result.
- **`ingestion_id` / `ingested_at`** — assign per source's serialized ingestion
  lane. Never bake ingestion/cursor assumptions into the library.
- Add a **`source_identity_kind LowCardinality(String)`** column to
  `dream.trajectory_records`.

## Determinism and fixture compatibility

Guaranteed identical across re-runs and transport-arrival order (for `native`
identity; `location`/`content` require in-order, append-only assembly):
`stable_source_record_id`, `source_group_id`, `source_order_id`, `record_id`,
`content_hash`, `component_index`.

`record_timestamp` and therefore `record_hash` can vary when timestamps are
synthesized/interpolated from record position; they are descriptive, not
identity. `source_order_id` never uses `record_timestamp`: records without a
source timestamp share a fixed missing-time sentinel that sorts as one
deterministic bucket, ordered within it by native sequence then
`stable_source_record_id`. The `meta` record's `cwd`/`git_branch`/`model` are
resolved from source chronology (earliest source timestamp, tie-broken by stable
id; model by highest count then lexicographically), so meta content and hashes
are arrival-order independent. Tool call↔result linkage is resolved independently of arrival order
using explicit tool-call ids, so a tool result links to its call even when it
appears earlier in the transcript (reversed chunks); the worker does not need to
pre-sort records into source order before normalizing. When a source exposes no
usable linkage, an orphan/duplicate diagnostic is emitted rather than relying on
caller order.

Per-adapter golden canonical outputs are pinned under
[`fixtures/canonical/`](fixtures/canonical) and asserted in
[`test/canonical.test.ts`](test/canonical.test.ts), which also covers
arrival-order independence, prefix/appended stability, exact duplicates,
conflicting versions, noisy Claude Code records, and malformed-input
diagnostics. Regenerate the golden fixtures only with an intentional,
reviewed change and bump `CANONICAL_SCHEMA_VERSION` when the contract changes.

### Diagnostics compatibility

`diagnostics[]` is always present and stable in shape (`code`, `message`, and
optional `inputLine`/`recordIndex`/`count`). Diagnostic `code` values are
additive: new codes may be introduced in a minor release, but existing codes are
not repurposed. Diagnostic text never contains raw transcript content.
