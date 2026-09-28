# Deploy guide

This guide names the transport concerns of a deploy and gives a starting point for each. It isn't a
per-host handbook. The formats and contracts behind it are in [ADR-0002](adr/0002-sharding-strategy.md)
(blocks), [ADR-0003](adr/0003-index-and-manifest-design.md) (index and manifest),
[ADR-0007](adr/0007-runtime-failure-contract.md) (failures) and
[ADR-0008](adr/0008-count-cost-and-pagination.md) (count and pagination cost).

`zonemapdb build` writes one tree (default `public/zonemapdb/`) meant to be served as-is by
whatever static host or CDN already serves the rest of your site. There is no server-side piece to
configure — only the handful of transport concerns below.

## Caching headers

- **`manifest.json`** is the one mutable, stable-named file — the entry point every client fetches
  first. Serve it with a short-lived or revalidating cache policy (e.g. `Cache-Control: no-cache`
  or a short `max-age`) so a redeploy is picked up promptly. The runtime asks for it with
  `cache: "no-cache"` either way, so the browser revalidates it once per session (a 304 when
  unchanged). Where a stale copy still gets through (a host like GitHub Pages that caches every file
  for 10 minutes, a CDN, a caching `fetch` wrapper), a 404 on a file the old manifest names makes the
  runtime refetch the manifest with `cache: "reload"` and rerun the query once against it.
- **Everything else** (`blocks/`, `index/`, and `zonemap/` when the manifest outgrows its budget) is content-hash-named and immutable by
  construction — a given filename's bytes never change. Serve these with
  `Cache-Control: public, max-age=31536000, immutable`. A rebuild that doesn't change a block's
  content reuses the same hash, so returning visitors keep it cached for free.

## CORS

If the data is served from a different origin than the page (a separate CDN/bucket, a
`basePath: "https://cdn…"` override), the host must send `Access-Control-Allow-Origin` for the
zonemapdb runtime's `fetch()` calls to succeed — a plain `*` is fine for public, read-only data.
Same-origin deploys (the common case: `public/zonemapdb/` under your own site) need nothing extra.

## Compression transport

- **Default (recommended): leave `compression` at `"none"`** and let the host's `Content-Encoding` do
  transport compression (as most static hosts/CDNs already do for JSON/NDJSON). This is why
  zonemapdb ships whole files instead of byte ranges — compression and range-reads don't fight
  each other here.
- **Build-time gzip (`"compression": "gzip"` in config)** pre-compresses **every file the deploy serves** — block
  payloads, index chunks, zonemap sidecars, and the root manifest — and the runtime decompresses them
  with the native `DecompressionStream` API (no library, no WASM). Use this only when your host can't
  apply `Content-Encoding` itself (some plain object-storage buckets don't). On a 25k-record dataset it
  took the served tree from 10.45 MB to 2.49 MB, and a single query from 612 KB to 157 KB.

  Two things change on disk, both deliberate:

  - Compressed files carry a `.gz` suffix (`blocks/1a2b….ndjson.gz`, `index/name/1a2b….json.gz`), and the manifest's own
    references already point at those names — the path is how the client knows the encoding, so a tree
    holding a mix of compressed and plain files still reads correctly.
  - The root manifest becomes `manifest.json.gz`. It is the bootstrap fetch, so nothing it points at
    can describe it; the generated client is stamped with the answer instead. **Deploy the generated
    client from the same `build`** — a client generated before you turned compression on will look
    for `manifest.json` and get a 404. (Hand-written `createClient` callers pass
    `manifestCompression: "gzip"`.)

  Content hashes are taken over the *uncompressed* bytes, but the suffix is part of the filename, so
  turning compression on or off gives every file a new URL and visitors download the tree again once.
  Rebuilds that keep the same setting reuse unchanged files as before.
- **Never double-compress**: if you enable build-time compression, make sure the host doesn't *also*
  re-gzip an already-gzipped `.gz` file — check the `Content-Encoding` response header actually
  served, not just what you configured. This is the main reason compression is off by default.
- The older `"gzip": true` key and the `manifestGzip: true` option still work but are deprecated;
  use `"compression": "gzip"` and `manifestCompression: "gzip"`.
- **Brotli** is available as `compression: "brotli"` (note the naming trap: the file suffix is `.br`,
  matching `Content-Encoding: br`, but the API's format string is `"brotli"`). **Only use it on a host
  that serves `.br` files with `Content-Encoding: br`**, so the browser decodes them at the transport
  layer. On a raw-bytes host (GitHub Pages, a plain object-storage bucket) the runtime falls back to
  `DecompressionStream("brotli")`, which is in the Compression Streams spec but that Chrome does not
  ship yet. Every query then fails with `CORRUPT_DATA` in Chrome. Use `gzip` on those hosts;
  `zonemapdb build` warns on every brotli build as a reminder. It is **not** the default, and the reason
  is not just client support:

  Brotli's advantage over gzip grows with file size, and zonemapdb deliberately ships *many small
  files*. Measured on real JSON: **7%** smaller on a 45 KB index chunk, **13%** at 256 KB, **24%** on
  a 1 MB block, **35%** on a 40 MB single blob. So zonemapdb operates at the low end of brotli's
  range — on a whole example deploy it came out 2.32 MB against gzip's 2.48 MB, a ~6% win.

  Prefer the host's transport-level brotli where you can have it: it gets the same ratio with per-client
  negotiation, which a baked file cannot. Reach for `compression: "brotli"` when the host compresses
  nothing and you want every byte.

## Request amplification

Many small files means many HTTP requests instead of one — this is the traded-off cost, not a bug.
A typical query costs: 1 manifest fetch (cached after first load) + 0–2 lazy index chunks (~40–50
KB each, only for secondary-field constraints) + the handful of blocks the zonemap/index narrowed
to. HTTP/2 or HTTP/3 (virtually universal on CDNs today) multiplexes these over one connection, so
the practical cost is closer to "a few more round trips," not "a few more TCP handshakes." There is no
adaptive prefetching — if a specific query pattern proves request-heavy in your app,
the fix is usually a config change (a bigger `blockBytes` target, indexing the field you actually
filter by) rather than client-side tuning.

## A `fetch` wrapper for retry, backoff and timeout

The runtime intentionally has **no built-in retry/backoff/timeout** (ADR-0007) — that's the
injected `fetch`'s job, so the runtime itself stays zero-dependency. A starting point:

```ts
import { connect } from "./zonemapdb/client";

const RETRIES = 3;
const TIMEOUT_MS = 10_000;

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // Time out each attempt, and still honour the query's own signal (a cancelled query mustn't retry).
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await fetch(input, { ...init, signal });
      // 5xx and 429 are worth another try; anything else (including 404) goes back to the runtime.
      if ((response.status < 500 && response.status !== 429) || attempt >= RETRIES) return response;
    } catch (err) {
      if (init?.signal?.aborted || attempt >= RETRIES) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt)); // 200, 400, 800 ms
  }
}

const db = connect({ fetch: fetchWithRetry });
```

In your own error handling, only `NETWORK` is worth retrying. `CONFIG`, `FORMAT_VERSION`,
`DEPLOY_INTEGRITY`, `CORRUPT_DATA`, `LIMIT_EXCEEDED` and `NEEDS_PRUNING` are non-retryable by
construction (a retry can't fix a wrong `basePath`, a version mismatch or a query shape), and
`ABORTED` isn't a failure: the caller cancelled the query.

## Recovering from `DEPLOY_INTEGRITY`

`DEPLOY_INTEGRITY` means the manifest referenced a block/chunk/sidecar that 404s (or that a
single-page-app fallback answered with `index.html`: zonemapdb never serves HTML, so an HTML response is
treated as the missing file it stands for), and a manifest
refetched with `cache: "reload"` still names it — almost always an
incomplete or half-propagated deploy (a CDN edge that hasn't caught up, or a deploy that uploaded
`manifest.json` before the files it points to finished uploading). Recovery is: re-run
`zonemapdb build` and redeploy the **whole** output tree together, and upload data files before
(or atomically with) `manifest.json` so a client can never observe a manifest pointing at files
that aren't there yet. An atomic directory swap on the host, or an upload that sends the manifest
last, avoids this class of issue entirely.

If the deploy is complete and the error persists, look for a cache that ignores the runtime's
`cache` mode: a CDN in front of the host, or a custom `fetch` that doesn't forward `init`. A cached
`index.html` still loads the old bundled client, but that client reads the new manifest, so it keeps
working unless the new build changed the manifest's compression or zonemapdb's major version (which
fail as `CONFIG` or `FORMAT_VERSION` rather than `DEPLOY_INTEGRITY`).
