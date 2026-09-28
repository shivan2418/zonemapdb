// The single catchable error surface (ADR-0007 §4): one exported class with a
// discriminated `code`, chosen over a subclass hierarchy — same narrowing, far
// less exported surface, no instanceof-across-bundlers fragility. Adding a code
// later is non-breaking.

/**
 * Every runtime failure maps to exactly one code — as fine-grained as the
 * caller's *reaction* differs, no finer (ADR-0007 §5):
 *
 * - `CONFIG` — manifest.json itself 404s / is unreachable (wrong basePath). Not retryable.
 * - `FORMAT_VERSION` — manifest major ≠ runtime major, checked when the manifest loads. Not retryable.
 * - `DEPLOY_INTEGRITY` — a manifest-referenced content-hashed block/chunk/sidecar 404s, and a freshly
 *   refetched manifest still names it (the client retries once past a stale cached manifest, #32). Not retryable.
 * - `NETWORK` — fetch rejected, or resolved non-ok non-404; optional `.status`. The one maybe-transient bucket.
 * - `CORRUPT_DATA` — 2xx body won't parse into JSON/NDJSON/domain structure. Not retryable.
 * - `LIMIT_EXCEEDED` — the `maxResults` ceiling (fail-loud, never truncates). Not retryable.
 * - `NEEDS_PRUNING` — a `findMany` where made only of riders, which would read every block (ADR-0013). Not retryable.
 * - `ABORTED` — the caller's `signal` fired, and the query's pending fetches were cancelled. Not a failure:
 *   usually a newer query superseded this one, so there is nothing to retry or log.
 */
export type ZonemapDbErrorCode =
  | "CONFIG"
  | "FORMAT_VERSION"
  | "DEPLOY_INTEGRITY"
  | "NETWORK"
  | "CORRUPT_DATA"
  | "LIMIT_EXCEEDED"
  | "NEEDS_PRUNING"
  | "ABORTED";

export interface ZonemapDbErrorInit {
  readonly code: ZonemapDbErrorCode;
  /** Human-readable, with remediation (ADR-0007 §8). */
  readonly message: string;
  /** The underlying thrown error, chained via native ES2022 `Error.cause`. */
  readonly cause?: unknown;
  /** The file being fetched when it failed — absent for LIMIT_EXCEEDED, NEEDS_PRUNING and ABORTED. */
  readonly url?: string;
  /** HTTP status — present on NETWORK-from-response and the two 404 codes. */
  readonly status?: number;
}

/**
 * The one error `findMany`/`count`/`get` ever throw for fetch/parse/limit
 * failures: `catch (e) { if (e instanceof ZonemapDbError && e.code === "…") … }`.
 * The triggering query object is deliberately NOT attached — a `where` can hold
 * PII-ish filter values that would land in logs (ADR-0007 §8).
 */
export class ZonemapDbError extends Error {
  readonly code: ZonemapDbErrorCode;
  // `declare` — no class field emitted, so conditionally-assigned optionals
  // stay truly absent ("url" in err ⇔ provided), per ADR-0007 §8.
  declare readonly url?: string;
  declare readonly status?: number;

  constructor(init: ZonemapDbErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ZonemapDbError";
    this.code = init.code;
    // Conditionally assigned so "absent" means absent (`"url" in err` ⇔ provided).
    if (init.url !== undefined) this.url = init.url;
    if (init.status !== undefined) this.status = init.status;
  }
}
