// The WHATWG-fetch → ZoneDbError mapping (ADR-0007 §3/§5/§6), shared by every
// file the runtime fetches. The injected fetch rejects on network-level failure
// but resolves on ANY HTTP status, so a fetch counts as failed when the promise
// rejects OR resolves !response.ok. No retry/backoff/timeout here — that is the
// injected fetch's / CDN's job (§2).

import { ZoneDbError } from "./errors.js";
import { decompressionFormat, type Compression } from "./types.js";

/**
 * 404 routes by WHICH file was being fetched — always known at the call site
 * (ADR-0007 §6): the manifest itself → `CONFIG` (wrong basePath); any
 * manifest-referenced content-hashed file → `DEPLOY_INTEGRITY` (corrupt deploy).
 */
export type FetchedFileKind = "manifest" | "referenced";

function messageFor404(kind: FetchedFileKind, url: string): string {
  return kind === "manifest"
    ? `zonedb: no manifest.json at "${url}" (HTTP 404) — check basePath: it must point at the deployed dataset root. If the dataset was never deployed there, re-run \`zonedb build\` and deploy the output.`
    : `zonedb: "${url}" referenced by the manifest returned HTTP 404 — the deploy is incomplete or corrupt, or a stale cache (a CDN, a fetch wrapper, or an old index.html / bundled client) is still serving an earlier deploy's manifest. If the deploy is complete, wait for caches to expire or hard-reload; otherwise re-run \`zonedb build\` and redeploy the whole output.`;
}

function messageForHtmlFallback(kind: FetchedFileKind, url: string): string {
  return kind === "manifest"
    ? `zonedb: "${url}" returned an HTML page instead of manifest.json, which is what a single-page-app fallback serves for a missing file — check basePath: it must point at the deployed dataset root.`
    : `zonedb: "${url}" referenced by the manifest returned an HTML page, which is what a single-page-app fallback serves for a missing file — the deploy is incomplete, or a stale cache is still serving an earlier deploy's manifest. If the deploy is complete, wait for caches to expire or hard-reload; otherwise re-run \`zonedb build\` and redeploy the whole output.`;
}

/**
 * Fetches `url`, mapping rejection / !ok to the right ZoneDbError code. Resolves only on 2xx.
 * `cache` is set only for the manifest (#32); content-hashed files leave it off so the browser's
 * normal (forever-valid) caching applies, and their `init` stays exactly `{ signal }`.
 */
async function fetchOk(
  url: string,
  kind: FetchedFileKind,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  cache?: RequestCache,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, cache === undefined ? { signal } : { signal, cache });
  } catch (cause) {
    throw new ZoneDbError({
      code: "NETWORK",
      url,
      message: `zonedb: fetch for "${url}" failed at the network level (${cause instanceof Error ? cause.message : String(cause)}) — possibly transient. Retry by wrapping the injected fetch, or check connectivity/CORS.`,
      cause,
    });
  }
  // A single-page-app fallback (Netlify/Vercel/Cloudflare rewrites, `serve -s`) answers a missing file
  // with 200 and index.html. zonedb never serves HTML, so that is the missing file, and it is routed as
  // the 404 it stands for. Otherwise it would surface as CORRUPT_DATA and skip the stale-manifest recovery.
  const servedHtml = response.ok && (response.headers?.get("content-type") ?? "").toLowerCase().startsWith("text/html");
  if (response.ok && !servedHtml) return response;
  if (response.status === 404 || servedHtml) {
    throw new ZoneDbError({
      code: kind === "manifest" ? "CONFIG" : "DEPLOY_INTEGRITY",
      url,
      status: response.status,
      message: servedHtml ? messageForHtmlFallback(kind, url) : messageFor404(kind, url),
    });
  }
  throw new ZoneDbError({
    code: "NETWORK",
    url,
    status: response.status,
    message: `zonedb: fetch for "${url}" returned HTTP ${response.status} — possibly transient. Retry by wrapping the injected fetch, or check the host/CDN.`,
  });
}

/** Fetch + JSON-parse; an unparseable 2xx body is CORRUPT_DATA (ADR-0007 §5). */
export async function fetchJson(
  url: string,
  kind: FetchedFileKind,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  cache?: RequestCache,
): Promise<unknown> {
  const response = await fetchOk(url, kind, fetchImpl, signal, cache);
  try {
    return await response.json();
  } catch (cause) {
    throw new ZoneDbError({
      code: "CORRUPT_DATA",
      url,
      message: `zonedb: the body of "${url}" would not parse as JSON — the deploy is corrupt. Re-run \`zonedb build\` and redeploy.`,
      cause,
    });
  }
}

/** Reads a 2xx body as text; a body that won't read is CORRUPT_DATA. */
async function readText(response: Response, url: string): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new ZoneDbError({
      code: "CORRUPT_DATA",
      url,
      message: `zonedb: the body of "${url}" could not be read — the deploy is corrupt. Re-run \`zonedb build\` and redeploy.`,
      cause,
    });
  }
}

/** Fetch + text; a 2xx body that won't read is CORRUPT_DATA. */
export async function fetchText(
  url: string,
  kind: FetchedFileKind,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  return await readText(await fetchOk(url, kind, fetchImpl, signal), url);
}

/** The compression a served path implies. `.br` is the file suffix; `"brotli"` is the API's format name. */
export function compressionOfPath(url: string): Compression {
  if (url.endsWith(".gz")) return "gzip";
  if (url.endsWith(".br")) return "brotli";
  return "none";
}

/** The `Content-Encoding` token a codec travels under — `br` on the wire, `"brotli"` to the API. */
const CONTENT_ENCODING_TOKEN: Record<"gzip" | "brotli", string> = { gzip: "gzip", brotli: "br" };

/**
 * Whether the fetch layer has ALREADY undone this file's build-time compression.
 *
 * Most static hosts recognise a `.gz`/`.br` suffix and answer with the matching `Content-Encoding`
 * (Vite's dev server, nginx `gzip_static`, most CDNs). The browser then decodes at the transport
 * layer and hands over a plain body — while leaving the header visible on the response. Decompressing
 * again would fail on what is already plain text, so the header is the signal to stand down.
 *
 * The match must be exact: a host that re-encodes our `.br` file as gzip has undone its own encoding,
 * not the build's, and the runtime still has to do its part.
 */
function alreadyDecodedByTransport(response: Response, format: "gzip" | "brotli"): boolean {
  const header = response.headers?.get("content-encoding");
  if (!header) return false;
  return header.split(",").some((token) => token.trim().toLowerCase() === CONTENT_ENCODING_TOKEN[format]);
}

/**
 * Fetch + decompress + text, for build-time-compressed files (ADR-0002 §8) — the native
 * `DecompressionStream` API, no library/WASM. A 2xx body that won't decompress, or won't read once
 * decompressed, is CORRUPT_DATA (same contract as `fetchText`).
 *
 * When the host serves the file under a matching `Content-Encoding`, the transport has already done
 * the work and this returns the body as-is. That path is worth more than a mere fix: transport-level
 * brotli is understood by every browser, whereas `DecompressionStream("brotli")` is not yet (Chrome
 * 150 still rejects it) — so a `.br` deploy behind such a host works where a raw-bytes one cannot.
 * Where the host serves raw bytes there is no fallback, which is why build-time compression stays
 * opt-in.
 */
export async function fetchCompressedText(
  url: string,
  kind: FetchedFileKind,
  format: "gzip" | "brotli",
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  cache?: RequestCache,
): Promise<string> {
  const response = await fetchOk(url, kind, fetchImpl, signal, cache);
  if (alreadyDecodedByTransport(response, format)) return await readText(response, url);
  try {
    // Cast: TypeScript's DOM lib still types CompressionFormat as gzip/deflate/deflate-raw, though
    // "brotli" is in the Compression Streams spec and shipping. The runtime check that matters is the
    // catch below — an engine without the format throws here and surfaces as CORRUPT_DATA.
    const decompressed = response.body!.pipeThrough(new DecompressionStream(format as CompressionFormat));
    return await new Response(decompressed).text();
  } catch (cause) {
    throw new ZoneDbError({
      code: "CORRUPT_DATA",
      url,
      message: `zonedb: the ${format} body of "${url}" could not be decompressed — the deploy is corrupt, or this browser lacks ${format} support in DecompressionStream. Re-run \`zonedb build\` and redeploy.`,
      cause,
    });
  }
}

/**
 * Fetch + JSON-parse a manifest-referenced file, decompressing first when the path says it was
 * built gzipped (ADR-0002 §8).
 *
 * Index chunks and zonemap sidecars are referenced from the manifest **by full path**, so the `.gz`
 * suffix is all the signal needed — no manifest flag to keep in sync, and a tree holding a mix of
 * compressed and plain files still reads correctly. That matters because content-hashed filenames
 * mean a rebuild replaces only the files whose contents changed.
 */
export async function fetchReferencedJson(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const format = decompressionFormat(compressionOfPath(url));
  if (format === undefined) return await fetchJson(url, "referenced", fetchImpl, signal);
  const text = await fetchCompressedText(url, "referenced", format, fetchImpl, signal);
  return parseCorruptible(url, () => JSON.parse(text) as unknown);
}

/** Parse/decode a 2xx body's CONTENT into a domain structure; failures are CORRUPT_DATA. */
export function parseCorruptible<T>(url: string, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new ZoneDbError({
      code: "CORRUPT_DATA",
      url,
      message: `zonedb: the body of "${url}" would not parse — the deploy is corrupt. Re-run \`zonedb build\` and redeploy.`,
      cause,
    });
  }
}
