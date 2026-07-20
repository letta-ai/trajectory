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

## Identity model

Identity is derived only from source-native signals — never from content or
transport-arrival position — so it is stable across re-runs and across the order
the worker coalesces upload chunks. `source_identity_kind` tells the worker how
confidently it can interpret conflicts:

- `native` — a source-native per-record id (Claude Code line `uuid`, Letta
  message `id`, OpenHands event `id`). Supports exact-duplicate dedup **and**
  conflicting-version detection.
- `location` — a stable source-native location anchor when no native id exists
  (append-only line offset for Codex, entry offset for local Letta / Deep
  Agents, Letta `seq_id`). Supports dedup and conflict detection for
  in-order, append-only assembly.
- `content` — content-addressed fallback when neither a native id nor a stable
  location exists. Supports exact-duplicate dedup **only**; it cannot detect a
  conflicting version of the same logical record.
- `synthetic` — the deterministic identity generated for the leading `meta`
  record.

`record_id = sha256([source_group_id, stable_source_record_id, componentKey])`,
where `componentKey` is a semantic key (`message`, `reasoning`,
`tool-call:<id>`, `tool-result:<id>`, `meta`) plus the within-source-record
`component_index`. One source record (one line/message) may expand into multiple
canonical components; each occurrence of the same source record produces
identical component keys, so exact duplicates collapse to the same `record_id`.

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
identity. Tool call↔result linkage is resolved in source order, so the worker
must assemble a source's records in logical order before normalizing.

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
