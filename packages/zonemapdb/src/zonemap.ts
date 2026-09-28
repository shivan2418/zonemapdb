// Zonemap pruning over the sort field's split-points (ADR-0002/0003): the
// split-points ARE the search structure — binary search finds the blocks that
// could possibly satisfy a where-filter on the sort field, so only those need
// to be fetched.

export type SortValue = number | string;

export interface SortFieldFilter {
  equals?: SortValue;
  in?: SortValue[];
  gt?: SortValue;
  gte?: SortValue;
  lt?: SortValue;
  lte?: SortValue;
  /** String sort fields only: a prefix is a contiguous range once values are sorted (ADR-0003 §7). */
  startsWith?: string;
}

/** Higher than any realistic code point in a stored value, so `[p, p + this]` brackets every string starting with `p`. */
const PREFIX_UPPER_SENTINEL = "\u{10FFFF}";

function pointBlockIndex(splitPoints: readonly SortValue[], value: SortValue, blockCount: number): number {
  let lo = 0;
  let hi = blockCount - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (splitPoints[mid]! <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function upperBoundBlockIndex(
  splitPoints: readonly SortValue[],
  value: SortValue,
  blockCount: number,
  strict: boolean,
): number {
  let lo = 0;
  let hi = blockCount - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const boundOk = strict ? splitPoints[mid]! < value : splitPoints[mid]! <= value;
    if (boundOk) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function isWithinGlobalRange(splitPoints: readonly SortValue[], value: SortValue): boolean {
  return value >= splitPoints[0]! && value <= splitPoints[splitPoints.length - 1]!;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** Block ordinals (into `manifest.blocks`) that could satisfy `filter` on the sort field. */
export function candidateBlockIndices(
  splitPoints: readonly SortValue[],
  filter: SortFieldFilter | undefined,
): number[] {
  const blockCount = splitPoints.length - 1;
  if (blockCount <= 0) return [];

  if (!filter || Object.keys(filter).length === 0) return range(0, blockCount - 1);

  if (filter.in !== undefined) {
    const indices = new Set<number>();
    for (const value of filter.in) {
      if (isWithinGlobalRange(splitPoints, value)) indices.add(pointBlockIndex(splitPoints, value, blockCount));
    }
    return [...indices].sort((a, b) => a - b);
  }

  if (filter.equals !== undefined) {
    if (!isWithinGlobalRange(splitPoints, filter.equals)) return [];
    return [pointBlockIndex(splitPoints, filter.equals, blockCount)];
  }

  // `startsWith(p)` IS the closed range [p, p+sentinel] on a sorted string field — free pruning off
  // the split-points already in the manifest, no index chunk to fetch. Composes with an explicit
  // range by intersecting: both bounds narrow the same span.
  const lower = filter.startsWith !== undefined ? filter.startsWith : (filter.gte ?? filter.gt);
  const upper =
    filter.startsWith !== undefined ? filter.startsWith + PREFIX_UPPER_SENTINEL : (filter.lte ?? filter.lt);
  const strictUpper = filter.startsWith === undefined && filter.lt !== undefined;

  const startIdx = lower !== undefined ? pointBlockIndex(splitPoints, lower, blockCount) : 0;
  const endIdx =
    upper !== undefined ? upperBoundBlockIndex(splitPoints, upper, blockCount, strictUpper) : blockCount - 1;

  if (endIdx < startIdx) return [];
  return range(startIdx, endIdx);
}

/**
 * A secondary field's constraint, in the shapes a per-block [min,max] pair can prune (ADR-0003 §6
 * step 1): point lookups (`equals`/`in`) and ranges (`gt`/`gte`/`lt`/`lte`).
 */
export interface PairRangeFilter {
  equals?: unknown;
  in?: unknown[];
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
}

function withinPair(pair: readonly [unknown, unknown], value: unknown): boolean {
  const [min, max] = pair;
  // A block with zero non-null values for this field has no bound to compare against (ADR-0002 §5/T7).
  if (min === undefined || max === undefined) return false;
  return (min as never) <= (value as never) && (value as never) <= (max as never);
}

function hasRangeBound(filter: PairRangeFilter): boolean {
  return filter.gt !== undefined || filter.gte !== undefined || filter.lt !== undefined || filter.lte !== undefined;
}

/**
 * Whether a block's [min,max] overlaps the filter's range — the only question a pair can answer
 * about a range. A block survives unless its whole span sits on one side of a bound.
 *
 * `gt`/`lt` differ from `gte`/`lte` only at the boundary: a block whose max is exactly the bound can
 * satisfy `gte` but not `gt`. Since number/date pairs are exact (only string pairs are truncated —
 * ADR-0003 §2), that distinction is sound rather than merely conservative.
 */
function overlapsRange(pair: readonly [unknown, unknown], filter: PairRangeFilter): boolean {
  const [min, max] = pair;
  if (min === undefined || max === undefined) return false;
  if (filter.gte !== undefined && (max as never) < (filter.gte as never)) return false;
  if (filter.gt !== undefined && (max as never) <= (filter.gt as never)) return false;
  if (filter.lte !== undefined && (min as never) > (filter.lte as never)) return false;
  if (filter.lt !== undefined && (min as never) >= (filter.lt as never)) return false;
  return true;
}

/**
 * Block ordinals whose per-block `[min,max]` pair could contain any of `filter`'s values — the
 * secondary-field counterpart of `candidateBlockIndices` (ADR-0003 §6 step 1: "apply all free
 * zonemap pruning first"). String bounds are truncated but never past the true value (ADR-0003
 * §2), so this can only ever OVER-approximate — it never excludes a real match. `undefined` means
 * the filter shape (e.g. `startsWith`) isn't one a min/max pair can prune; the caller should treat
 * that as "no zonemap signal" rather than as an empty set.
 */
export function pairCandidateBlockIndices(
  pairs: readonly (readonly [unknown, unknown])[],
  filter: PairRangeFilter,
): Set<number> | undefined {
  const hasPoint = filter.equals !== undefined || filter.in !== undefined;
  const hasRange = hasRangeBound(filter);
  if (!hasPoint && !hasRange) return undefined;

  // Point and range constraints on one field are ANDed, matching `matchesWhere`: `{ equals: 5, gte: 10 }`
  // is unsatisfiable and must prune to nothing, not to the union of what each shape would admit.
  const values = filter.in ?? [filter.equals];
  const indices = new Set<number>();
  pairs.forEach((pair, i) => {
    if (hasPoint && !values.some((value) => withinPair(pair, value))) return;
    if (hasRange && !overlapsRange(pair, filter)) return;
    indices.add(i);
  });
  return indices;
}
