import { fetchIndexChunk } from "./index-fetch.js";
import { ZoneDbError } from "./errors.js";
import { parseCorruptible } from "./fetch-file.js";
import { matchesWhere } from "./filter.js";
import { datasetCompression, fetchManifest, manifestReferences, type IndexChunkDirEntry, type IndexDescriptor, type Manifest, type PairZonemapEntry } from "./manifest.js";
import {
  chunksForFilter,
  decodeIndexChunk,
  reverseString,
  blockIndicesForFilter,
  trigramsOf,
  type IndexChunkFile,
  type SecondaryFieldFilter,
} from "./secondary-index.js";
import { fetchBlockRecords } from "./block-fetch.js";
import {
  assertWhereHasPruning,
  compactWhere,
  type ClientOptions,
  type CollectionMeta,
  type CountResult,
  type FieldKind,
  type GenericClient,
  type SchemaMeta,
} from "./types.js";
import {
  candidateBlockIndices,
  pairCandidateBlockIndices,
  type PairRangeFilter,
  type SortFieldFilter,
  type SortValue,
} from "./zonemap.js";
import { fetchZonemapSidecar } from "./zonemap-fetch.js";

interface RawFindManyArgs {
  where?: Record<string, Record<string, unknown>>;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
  scan?: "block-order";
}

/** Only equals/in/startsWith prune via the inverted index (ADR-0003 §7); other keys (e.g. `not`) don't. */
function secondaryFilterOf(rawFilter: Record<string, unknown>): SecondaryFieldFilter | undefined {
  const { equals, in: inValues, startsWith } = rawFilter;
  if (equals === undefined && inValues === undefined && startsWith === undefined) return undefined;
  return { equals, in: inValues as unknown[] | undefined, startsWith: startsWith as string | undefined };
}

/**
 * The part of a filter a per-block [min,max] pair can prune: point lookups plus ranges. Ranges are
 * zonemap-only — the inverted index is a dictionary of exact values, and a range has no key to look
 * up — so they are extracted separately from `secondaryFilterOf` rather than widening it.
 */
function pairFilterOf(rawFilter: Record<string, unknown>): PairRangeFilter | undefined {
  const { equals, in: inValues, gt, gte, lt, lte } = rawFilter;
  if (equals === undefined && inValues === undefined && gt === undefined && gte === undefined && lt === undefined && lte === undefined) {
    return undefined;
  }
  return { equals, in: inValues as unknown[] | undefined, gt, gte, lt, lte };
}

/**
 * A multi-valued field's index is built over its elements, so pruning reads through `some`/`every`
 * to their element filter (T7, ADR-0010): `"x"` unwraps to `{ equals: "x" }`, an object form is used
 * as-is.
 */
function unwrapElementFilter(elementFilter: unknown): Record<string, unknown> {
  if (typeof elementFilter === "object" && elementFilter !== null) return elementFilter as Record<string, unknown>;
  return { equals: elementFilter };
}

/** `a ∪ b` over block ordinals. */
function unionSets(a: Set<number>, b: Set<number>): Set<number> {
  return new Set([...a, ...b]);
}

/** The plumbing every chunk/block fetch in one query shares — travels as a unit rather than three loose params. */
interface FetchContext {
  basePath: string;
  fetchImpl: typeof fetch;
  chunkCache: Map<string, Promise<IndexChunkFile>>;
  /** Spilled secondary zonemaps this query has already fetched, keyed by sidecar path (ADR-0003 §3) — one fetch per sidecar per query, however many fields/filters touch it. */
  zonemapCache: Map<string, Promise<PairZonemapEntry>>;
  /** Passed to every fetch in this query; fired on the first failure (ADR-0007 §7). */
  signal: AbortSignal;
  /** First-failure-wins: aborts the shared controller, then rethrows — so Promise.all rejects fast and outstanding fetches cancel. */
  track<T>(promise: Promise<T>): Promise<T>;
  /** Sync counterpart of track, for post-fetch decode/parse steps — the same first-failure abort must fire (ADR-0007 §7). */
  trackSync<T>(fn: () => T): T;
  /** Unhooks the caller's signal once the query is over, so a long-lived signal doesn't collect listeners. */
  dispose(): void;
}

/**
 * `callerSignal` is the query's `signal` option: when it fires, the same controller that the first
 * failure fires aborts every fetch still pending in this query.
 */
function makeFetchContext(basePath: string, fetchImpl: typeof fetch, callerSignal?: AbortSignal): FetchContext {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal!.reason);
  // An abort event has already fired for a signal that is aborted by now, so the listener would never run.
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const abortAndRethrow = (error: unknown): never => {
    controller.abort(error);
    throw error;
  };
  return {
    basePath,
    fetchImpl,
    chunkCache: new Map(),
    zonemapCache: new Map(),
    signal: controller.signal,
    track: (promise) => promise.catch(abortAndRethrow),
    trackSync: (fn) => {
      try {
        return fn();
      } catch (error) {
        return abortAndRethrow(error);
      }
    },
    dispose: () => callerSignal?.removeEventListener("abort", onCallerAbort),
  };
}

function abortedError(signal: AbortSignal): ZoneDbError {
  return new ZoneDbError({
    code: "ABORTED",
    message:
      "zonedb: the query was cancelled by its signal, and its pending fetches were aborted. Nothing is wrong " +
      "with the deploy; if a newer query superseded this one, ignore it.",
    cause: signal.reason,
  });
}

/**
 * Settles with `promise`, or rejects with ABORTED as soon as `signal` fires, whichever comes first.
 * Used for waits a query doesn't own: the shared manifest fetch keeps going for the other queries,
 * and an injected fetch that ignores its signal can't hold a cancelled query open.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    // Nobody else may be listening to `promise`; its later rejection mustn't surface as unhandled.
    promise.catch(() => {});
    return Promise.reject(abortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Resolves a secondary field's zonemap — already-inline `pairs`, or a lazy fetch of its sidecar
 * the first time this query touches it (ADR-0003 §3: root stays "routing-essential only", rich
 * pruning data is pay-on-use). `undefined` when the field carries no zonemap entry at all (e.g.
 * it isn't indexed, or is the sort field, which is pruned separately via `splitPoints`).
 */
async function resolveSecondaryZonemap(
  manifest: Manifest,
  ctx: FetchContext,
  field: string,
): Promise<PairZonemapEntry | undefined> {
  const entry = manifest.zonemap[field];
  if (!entry || "splitPoints" in entry) return undefined;
  if (!("sidecar" in entry)) return entry;

  let promise = ctx.zonemapCache.get(entry.sidecar);
  if (!promise) {
    promise = ctx.track(fetchZonemapSidecar(ctx.basePath, entry.sidecar, ctx.fetchImpl, ctx.signal));
    ctx.zonemapCache.set(entry.sidecar, promise);
  }
  return await promise;
}

/** `a ∩ b` over block ordinals — the one intersection shape every AND-combination step shares. */
function intersectSets(a: Set<number>, b: Set<number>): Set<number> {
  return new Set([...a].filter((i) => b.has(i)));
}

/** Fetches+decodes the chunks a filter could touch, resolving them into a candidate block set. */
async function candidatesFromChunkedIndex(
  ctx: FetchContext,
  chunks: IndexChunkDirEntry[],
  kind: FieldKind,
  filter: SecondaryFieldFilter,
): Promise<Set<number>> {
  const blockIndices = new Set<number>();
  for (const chunkDir of chunksForFilter(chunks, filter)) {
    let chunkPromise = ctx.chunkCache.get(chunkDir.file);
    if (!chunkPromise) {
      chunkPromise = ctx.track(fetchIndexChunk(ctx.basePath, chunkDir.file, ctx.fetchImpl, ctx.signal));
      ctx.chunkCache.set(chunkDir.file, chunkPromise);
    }
    const awaitedChunk = await chunkPromise;
    const decoded = ctx.trackSync(() =>
      parseCorruptible(`${ctx.basePath}/${chunkDir.file}`, () => decodeIndexChunk(awaitedChunk, kind)),
    );
    for (const blockIndex of blockIndicesForFilter(decoded, filter)) blockIndices.add(blockIndex);
  }
  return blockIndices;
}

/**
 * `contains`'s candidate set (ADR-0003 §7): AND-intersect the block sets of
 * every query trigram — any block truly holding a match has ALL of them
 * present somewhere, so intersecting can only over-approximate, never miss.
 * A query shorter than 3 chars has no trigrams to route on — `undefined`
 * signals "can't prune via this field," same as an absent index.
 */
async function containsCandidates(
  ctx: FetchContext,
  chunks: IndexChunkDirEntry[],
  substring: string,
): Promise<Set<number> | undefined> {
  const grams = trigramsOf(substring);
  if (grams.length === 0) return undefined;

  let result: Set<number> | undefined;
  for (const gram of grams) {
    const gramSet = await candidatesFromChunkedIndex(ctx, chunks, "string", { equals: gram });
    result = result === undefined ? gramSet : intersectSets(result, gramSet);
    if (result.size === 0) break;
  }
  return result;
}

/**
 * Fetches+intersects EVERY structure one secondary field's filter constrains
 * — the base index (equals/in/startsWith), the reversed index (endsWith),
 * and the trigram index (contains) are independent structures, so each
 * contributes its own candidate set and they AND together (ADR-0003 §7/§9).
 */
async function secondaryFieldCandidates(
  manifest: Manifest,
  ctx: FetchContext,
  field: string,
  rawFilter: Record<string, unknown>,
): Promise<Set<number> | undefined> {
  const indexDescriptor = manifest.indexes[field];
  if (!indexDescriptor) return undefined;
  const fieldMeta = manifest.schema.fields[field]!;
  if (fieldMeta.multi) return listFieldCandidates(manifest, ctx, field, indexDescriptor, rawFilter);
  return valueFilterCandidates(manifest, ctx, field, indexDescriptor, rawFilter);
}

/**
 * A multi-valued field's candidates: each list operator present contributes a set, and they AND
 * together like any keys on one field (ADR-0010 §2/§4). An operator that can't prune contributes
 * nothing rather than an empty set.
 */
async function listFieldCandidates(
  manifest: Manifest,
  ctx: FetchContext,
  field: string,
  indexDescriptor: IndexDescriptor,
  rawFilter: Record<string, unknown>,
): Promise<Set<number> | undefined> {
  const { some, every, hasEvery, isEmpty } = rawFilter as {
    some?: unknown;
    every?: unknown;
    hasEvery?: unknown[];
    isEmpty?: boolean;
  };
  // Missing on a manifest built before ADR-0010: unknown, so isEmpty/every can't prune — never "none".
  const emptyBlocks = indexDescriptor.emptyBlocks && new Set(indexDescriptor.emptyBlocks);
  const sets: Set<number>[] = [];

  if (some !== undefined) {
    const someSet = await valueFilterCandidates(manifest, ctx, field, indexDescriptor, unwrapElementFilter(some));
    if (someSet) sets.push(someSet);
  }

  // A list passing `every: F` either has an element — which satisfies F, so it sits in `some: F`'s
  // postings — or is empty, so it sits in an emptyBlocks block.
  if (every !== undefined && emptyBlocks) {
    const elementSet = await valueFilterCandidates(manifest, ctx, field, indexDescriptor, unwrapElementFilter(every));
    if (elementSet) sets.push(unionSets(elementSet, emptyBlocks));
  }

  // Every value must be present, so a match sits in every value's postings: intersect, not union.
  if (hasEvery !== undefined && hasEvery.length > 0) {
    const kind = manifest.schema.fields[field]!.kind as FieldKind;
    for (const value of hasEvery) {
      sets.push(await candidatesFromChunkedIndex(ctx, indexDescriptor.chunks, kind, { equals: value }));
    }
  }

  if (isEmpty === true && emptyBlocks) sets.push(emptyBlocks);

  if (sets.length === 0) return undefined;
  return sets.reduce(intersectSets);
}

/** One value filter's candidates — a scalar field's filter, or a multi field's element filter. */
async function valueFilterCandidates(
  manifest: Manifest,
  ctx: FetchContext,
  field: string,
  indexDescriptor: IndexDescriptor,
  effectiveFilter: Record<string, unknown>,
): Promise<Set<number> | undefined> {
  const kind = manifest.schema.fields[field]!.kind as FieldKind;
  const { endsWith, contains } = effectiveFilter as { endsWith?: string; contains?: string };
  const sets: Set<number>[] = [];

  // ADR-0003 §6 step 1: free zonemap pruning before the pay-on-use index-chunk fetch. The zonemap can
  // only over-approximate (never wrongly excludes a real match — ADR-0003 §2), so intersecting it in
  // never changes the final (already-exact) index result; it's how a secondary field's zonemap —
  // inline or a lazily-fetched sidecar (T13, ADR-0003 §3) — gets exercised at all, since equals/in are
  // otherwise resolved exactly via the index alone. For a RANGE it is the only pruning available, and
  // the pairs are exact for number/date (only string pairs are truncated), so it prunes precisely.
  const pairFilter = pairFilterOf(effectiveFilter);
  if (pairFilter) {
    const zonemap = await resolveSecondaryZonemap(manifest, ctx, field);
    const zonemapSet = zonemap && pairCandidateBlockIndices(zonemap.pairs, pairFilter);
    if (zonemapSet) sets.push(zonemapSet);
  }

  // Step 2: the inverted index, for the shapes that have a dictionary key to look up.
  const baseFilter = secondaryFilterOf(effectiveFilter);
  if (baseFilter) {
    sets.push(await candidatesFromChunkedIndex(ctx, indexDescriptor.chunks, kind, baseFilter));
  }

  if (endsWith !== undefined && indexDescriptor.reversed) {
    sets.push(
      await candidatesFromChunkedIndex(ctx, indexDescriptor.reversed.chunks, "string", {
        startsWith: reverseString(endsWith),
      }),
    );
  }

  if (contains !== undefined && indexDescriptor.trigram) {
    const trigramSet = await containsCandidates(ctx, indexDescriptor.trigram.chunks, contains);
    if (trigramSet) sets.push(trigramSet);
  }

  if (sets.length === 0) return undefined;
  return sets.reduce(intersectSets);
}

/**
 * Block ordinals surviving zonemap + postings pruning for `where`, ascending.
 * Free zonemap pruning on the sort field first (ADR-0003 §6 step 1), then
 * fetch+intersect the index chunks for every equals/in/startsWith-constrained
 * secondary field (step 2) — cheap chunk fetches before blocks.
 */
async function candidateIndicesForWhere(
  manifest: Manifest,
  ctx: FetchContext,
  where: Record<string, Record<string, unknown>> | undefined,
): Promise<number[]> {
  const sortField = manifest.dataset.sortField;
  const sortFieldFilter = where?.[sortField] as SortFieldFilter | undefined;
  const sortZonemap = manifest.zonemap[sortField] as { splitPoints?: SortValue[] } | undefined;
  const splitPoints = sortZonemap?.splitPoints ?? [];

  let candidateSet = new Set(candidateBlockIndices(splitPoints, sortFieldFilter));
  const secondaryEntries = Object.entries(where ?? {}).filter(([field]) => field !== sortField);
  const secondarySets = await Promise.all(
    secondaryEntries.map(([field, filter]) => secondaryFieldCandidates(manifest, ctx, field, filter)),
  );
  for (const set of secondarySets) {
    if (set === undefined) continue;
    candidateSet = intersectSets(candidateSet, set);
  }
  return [...candidateSet].sort((a, b) => a - b);
}

/**
 * Approximate upper bound with zero data-block fetches (ADR-0008 §2): sum
 * `manifest.blocks[i].count` over the blocks surviving zonemap + postings
 * pruning. `exact: true` only for an empty where and pruned-to-zero (§3).
 */
async function executeCount(
  manifest: Manifest,
  ctx: FetchContext,
  where: Record<string, Record<string, unknown>> | undefined,
): Promise<CountResult> {
  if (!where || Object.keys(where).length === 0) {
    return { count: manifest.dataset.recordCount, exact: true };
  }
  const candidateIndices = await candidateIndicesForWhere(manifest, ctx, where);
  if (candidateIndices.length === 0) return { count: 0, exact: true };
  let count = 0;
  for (const index of candidateIndices) count += manifest.blocks[index]!.count;
  return { count, exact: false };
}

const DEFAULT_MAX_RESULTS = 10_000;

/** The explicit-limit half of the maxResults guardrail — pure validation, runs before any fetch. */
function assertLimitWithinCeiling(limit: number | undefined, maxResults: number): void {
  if (limit !== undefined && limit > maxResults) {
    throw new ZoneDbError({
      code: "LIMIT_EXCEEDED",
      message:
        `zonedb: limit ${limit} exceeds the maxResults ceiling ${maxResults} — ` +
        `lower the query's limit, or raise maxResults in connect() if you truly need more.`,
    });
  }
}

/**
 * `orderBy` may name any indexed field, not just the sort field (ADR-0001 item 42). Records are
 * already fully materialized in memory by the time this runs, so a plain multi-key stable sort
 * (iterating `orderBy`'s own key order for tiebreaks) is correct and doesn't disturb the exact
 * `hasMore` accounting, which only depends on `matches.length`, not on ordering.
 */
function compareByOrderBy(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  orderBy: Record<string, "asc" | "desc">,
): number {
  for (const [field, direction] of Object.entries(orderBy)) {
    const av = a[field];
    const bv = b[field];
    if (av === bv) continue;
    let cmp: number;
    if (av === undefined || av === null) cmp = -1;
    else if (bv === undefined || bv === null) cmp = 1;
    else if (av < bv) cmp = -1;
    else if (av > bv) cmp = 1;
    else cmp = 0;
    if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
  }
  return 0;
}

function fetchBlockAt(manifest: Manifest, ctx: FetchContext, index: number): Promise<Record<string, unknown>[]> {
  return ctx.track(
    fetchBlockRecords(
      ctx.basePath,
      manifest.blocks[index]!.hash,
      manifest.blocks.length,
      datasetCompression(manifest),
      ctx.fetchImpl,
      ctx.signal,
    ),
  );
}

/**
 * Blocks per round of the walk. Fetching strictly one at a time would minimise bytes but serialise a
 * round trip per block; a small window keeps the requests parallel while still stopping within
 * `BLOCK_WALK_BATCH - 1` blocks of the page being filled. The comparison that matters is against
 * fetching *every* candidate, which is what this replaces.
 */
const BLOCK_WALK_BATCH = 4;

/**
 * A `scan: "block-order"` query skips the rider rule, which is only safe while the walk can stop at
 * the first full page: a `limit`, and no ordering the blocks don't already have.
 */
function assertBlockOrderScan(manifest: Manifest, args: RawFindManyArgs): void {
  const sortField = manifest.dataset.sortField;
  if (args.scan !== "block-order") {
    throw new ZoneDbError({
      code: "CONFIG",
      message: `zonedb: unknown scan mode ${JSON.stringify(args.scan)} — the only one is "block-order".`,
    });
  }
  if (blockWalkDirection(manifest, args) !== undefined) return;
  throw new ZoneDbError({
    code: "NEEDS_PRUNING",
    message:
      `zonedb: scan: "block-order" walks the data files in sort order and stops once the page is full, so it ` +
      `needs a \`limit\` and no \`orderBy\` other than the sort field "${sortField}"` +
      (args.limit === undefined ? `. This query has no limit.` : `. This query's orderBy can't be answered in block order.`) +
      ` See "Scanning in block order" in docs/query-guide.md.`,
  });
}

/**
 * Which direction to walk candidate blocks when a bounded query's requested order already matches
 * their physical order — `undefined` when it doesn't, meaning every candidate has to be fetched
 * before the ordering (and therefore the page) is known.
 */
function blockWalkDirection(manifest: Manifest, args: RawFindManyArgs | undefined): "asc" | "desc" | undefined {
  // Without a limit every match is returned, so there is no page to stop at.
  if (args?.limit === undefined) return undefined;

  const orderBy = args.orderBy;
  const keys = orderBy === undefined ? [] : Object.keys(orderBy);
  // No orderBy: the result order IS block order, so walking is exactly equivalent to the full fetch.
  if (keys.length === 0) return "asc";

  const sortField = manifest.dataset.sortField;
  if (keys.length !== 1 || keys[0] !== sortField) return undefined;

  // An explicit orderBy on the sort field agrees with block order only when nothing has a
  // null/absent sort value: those sit at the HIGH end on disk (ADR-0002 §9) but compare as lowest,
  // so the two disagree and only materialize-then-sort places them correctly.
  const zonemap = manifest.zonemap[sortField];
  if (zonemap !== undefined && "splitPoints" in zonemap && zonemap.missing !== undefined) return undefined;

  return orderBy![sortField] === "desc" ? "desc" : "asc";
}

/**
 * ADR-0008 §5: walk candidate blocks in sort order accumulating post-filtered matches until
 * `offset + limit + 1` exist, then stop. The `+1` is what makes `hasMore` exact without a second
 * query. Because the accumulated matches are a prefix of the globally ordered result set, slicing
 * the page out of them is identical to slicing it out of every match — for a fraction of the bytes
 * when the filter is unselective (the case where fetching all candidates hurt most).
 */
async function findManyByBlockWalk(
  manifest: Manifest,
  ctx: FetchContext,
  candidateIndices: number[],
  args: RawFindManyArgs,
  direction: "asc" | "desc",
): Promise<{ records: Record<string, unknown>[]; hasMore: boolean; total?: number }> {
  const limit = args.limit!;
  const offset = args.offset ?? 0;
  const needed = offset + limit + 1;
  const order = direction === "asc" ? candidateIndices : [...candidateIndices].reverse();

  const matches: Record<string, unknown>[] = [];
  // How many candidates the walk actually read. Pruning is conservative — every match lives in a
  // candidate — so reading all of them means `matches` IS the whole match set and its size is exact.
  let read = 0;
  for (let i = 0; i < order.length && matches.length < needed; i += BLOCK_WALK_BATCH) {
    const batch = order.slice(i, i + BLOCK_WALK_BATCH);
    const fetched = await Promise.all(batch.map((index) => fetchBlockAt(manifest, ctx, index)));
    for (const records of fetched) {
      // Records within a block are ascending by the sort field; a descending walk reverses each
      // block as well as the block order. Ties among equal sort values are unordered either way.
      for (const record of direction === "asc" ? records : [...records].reverse()) {
        if (matchesWhere(record, args.where)) matches.push(record);
      }
    }
    read += batch.length;
  }

  const windowed = matches.slice(offset);
  return {
    records: windowed.slice(0, limit),
    hasMore: windowed.length > limit,
    // Stopping early is the walk's whole point, and it means the tail was never seen — no total then.
    ...(read === order.length ? { total: matches.length } : {}),
  };
}

async function executeFindMany(
  manifest: Manifest,
  ctx: FetchContext,
  args: RawFindManyArgs | undefined,
  maxResults: number,
): Promise<{ records: Record<string, unknown>[]; hasMore: boolean; total?: number }> {
  const candidateIndices = await candidateIndicesForWhere(manifest, ctx, args?.where);

  const walkDirection = blockWalkDirection(manifest, args);
  if (walkDirection !== undefined) {
    return await findManyByBlockWalk(manifest, ctx, candidateIndices, args!, walkDirection);
  }

  const fetched = await Promise.all(
    candidateIndices.map(async (index) => ({ index, records: await fetchBlockAt(manifest, ctx, index) })),
  );
  fetched.sort((a, b) => a.index - b.index);

  // Fetched blocks are individually sorted ascending by the sort field, and
  // fetched/concatenated in ascending block-index order — the concatenation
  // is already globally ascending; filtering never reorders it.
  let matches: Record<string, unknown>[] = [];
  for (const { records } of fetched) {
    for (const record of records) {
      if (matchesWhere(record, args?.where)) matches.push(record);
    }
  }

  // The unbounded half of the maxResults guardrail: a query with no explicit
  // limit that would exceed the ceiling throws rather than silently truncating
  // (ADR-0004 — partial results are indistinguishable from smaller correct ones).
  if (args?.limit === undefined && matches.length > maxResults) {
    throw new ZoneDbError({
      code: "LIMIT_EXCEEDED",
      message:
        `zonedb: this unbounded query matched more than the maxResults ceiling of ${maxResults} records — ` +
        `add a limit ≤ ${maxResults} to paginate, or raise maxResults in connect(). Refusing to silently truncate.`,
    });
  }

  if (args?.orderBy && Object.keys(args.orderBy).length > 0) {
    const orderBy = args.orderBy;
    matches = [...matches].sort((a, b) => compareByOrderBy(a, b, orderBy));
  }

  // This path read every candidate block, so `matches` is the complete match set — the exact total
  // comes for free, even when only one page of it is returned.
  const total = matches.length;
  const offset = args?.offset ?? 0;
  const windowed = matches.slice(offset);
  if (args?.limit === undefined) {
    return { records: windowed, hasMore: false, total };
  }
  return { records: windowed.slice(0, args.limit), hasMore: windowed.length > args.limit, total };
}

export function createClient<S extends SchemaMeta, Records>(
  schema: S,
  opts: ClientOptions,
): GenericClient<S, Records> {
  const basePath = opts.basePath.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const manifestCompression = opts.manifestCompression ?? (opts.manifestGzip === true ? "gzip" : "none");
  let manifestPromise: Promise<Manifest> | undefined;
  // A failed first fetch (a 503 on page load, a dropped connection) isn't remembered either: the next
  // query tries again rather than inheriting the rejection until reload.
  const getManifest = (): Promise<Manifest> => {
    if (manifestPromise) return manifestPromise;
    const promise = fetchManifest(basePath, fetchImpl, manifestCompression).catch((error: unknown) => {
      if (manifestPromise === promise) manifestPromise = undefined;
      throw error;
    });
    return (manifestPromise = promise);
  };

  // The one in-flight (or finished) refetch, keyed by the manifest it replaces. Every query that
  // failed against that same stale manifest shares it, so a burst of concurrent queries after a
  // redeploy costs one manifest request, not one each.
  let refresh: { stale: Manifest; promise: Promise<Manifest> } | undefined;
  const refreshManifest = (stale: Manifest): Promise<Manifest> => {
    if (refresh?.stale === stale) return refresh.promise;
    const promise = fetchManifest(basePath, fetchImpl, manifestCompression, "reload").then(
      (fresh) => {
        manifestPromise = Promise.resolve(fresh);
        return fresh;
      },
      (error: unknown) => {
        // A failed refetch isn't remembered: the next failing query tries again.
        if (refresh?.promise === promise) refresh = undefined;
        throw error;
      },
    );
    refresh = { stale, promise };
    return promise;
  };

  /**
   * Runs one query against the manifest, recovering once from a stale cached manifest (#32).
   *
   * Content-hashed files never go stale, but the manifest's name is the same across deploys, and a
   * host that caches it (despite the `no-cache` revalidation, e.g. a CDN or a caching fetch wrapper)
   * can hand back the previous deploy's copy, which names files the new deploy removed. So a
   * DEPLOY_INTEGRITY 404 refetches the manifest with `cache: "reload"`. If the fresh manifest no
   * longer names the missing file it replaces the cached one and the query reruns once against it
   * (index chunks and sidecars are cached per query, so there is nothing else to drop). If it still
   * names the file, that's a real partial deploy and the original error is thrown. A second
   * failure on the rerun throws as-is: the retry is bounded at one, so it can never loop.
   *
   * `signal` is the caller's: it aborts this query's own fetches, and a cancelled query rejects with
   * ABORTED and never retries. The shared manifest fetch and refetch are only raced, never aborted,
   * because other queries may be waiting on them.
   */
  const withManifest = async <T>(
    signal: AbortSignal | undefined,
    run: (manifest: Manifest, ctx: FetchContext) => Promise<T>,
  ): Promise<T> => {
    const attempt = async (manifest: Manifest): Promise<T> => {
      // The signal can fire while the manifest resolves; don't start fetches for a cancelled query.
      if (signal?.aborted) throw abortedError(signal);
      const ctx = makeFetchContext(basePath, fetchImpl, signal);
      try {
        return await raceAbort(run(manifest, ctx), signal);
      } finally {
        ctx.dispose();
      }
    };

    const manifest = await raceAbort(getManifest(), signal);
    try {
      return await attempt(manifest);
    } catch (error) {
      // Whatever a cancelled query's fetches threw on the way out, the caller asked for this.
      if (signal?.aborted) throw abortedError(signal);
      if (!(error instanceof ZoneDbError) || error.code !== "DEPLOY_INTEGRITY" || error.url === undefined) throw error;
      // A refetch that itself fails (a 5xx, a FORMAT_VERSION from a newer build) throws its own,
      // more telling, error.
      const fresh = await raceAbort(refreshManifest(manifest), signal);
      if (manifestReferences(fresh, basePath, error.url)) throw error;
      return await attempt(fresh);
    }
  };

  const makeCollection = (meta: CollectionMeta) => {
    const collection: Record<string, unknown> = {
      findMany: async (args?: RawFindManyArgs) => {
        assertLimitWithinCeiling(args?.limit, maxResults);
        if (args?.where !== undefined) args = { ...args, where: compactWhere(args.where) };
        return withManifest(args?.signal, (manifest, ctx) => {
          // After the manifest (which says what prunes on this dataset), before any index or block fetch.
          if (args?.scan !== undefined) assertBlockOrderScan(manifest, args);
          else assertWhereHasPruning(args?.where, manifest.schema);
          return executeFindMany(manifest, ctx, args, maxResults);
        });
      },
      count: async (where?: Record<string, Record<string, unknown>>, opts?: { signal?: AbortSignal }) =>
        withManifest(opts?.signal, (manifest, ctx) => executeCount(manifest, ctx, compactWhere(where))),
      getSchema: () => meta,
    };

    // `get(id)` is equality-on-PK through the same candidate-block machinery as
    // `findMany` (ADR-0003 §10) — free (≤1 block) when the PK is the sort field
    // (zonemap alone pinpoints it), else ≤1 index chunk + ≤1 block. Omitted
    // entirely (not even a stubbed throw) when no PK was declared (T1/ADR-0004).
    if (meta.pk !== undefined) {
      const pkField = meta.pk;
      collection.get = async (id: unknown, opts?: { signal?: AbortSignal }) => {
        const { records } = await withManifest(opts?.signal, (manifest, ctx) =>
          executeFindMany(manifest, ctx, { where: { [pkField]: { equals: id } }, limit: 1 }, maxResults),
        );
        return records[0] ?? null;
      };
    }

    return collection;
  };

  const out: Record<string, unknown> = {};
  for (const name of Object.keys(schema)) out[name] = makeCollection(schema[name]!);
  return out as GenericClient<S, Records>;
}
