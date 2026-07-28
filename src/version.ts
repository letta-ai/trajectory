/**
 * Runtime provenance constants recorded by the Cloud normalizer worker on every
 * canonical record it derives from this package.
 *
 * `NORMALIZER_VERSION` is the exact published npm version of this package. It is
 * runtime provenance for the deployed artifact; the `version.test.ts` guard
 * asserts it stays in lockstep with `package.json`.
 *
 * `CANONICAL_SCHEMA_VERSION` versions the canonical-record contract itself (the
 * field set and semantics consumed by the worker / ClickHouse). It is bumped
 * manually and only when the canonical contract changes, independently of
 * packaging-only releases.
 */
export const NORMALIZER_VERSION = "0.2.5";

export const CANONICAL_SCHEMA_VERSION = 2;
