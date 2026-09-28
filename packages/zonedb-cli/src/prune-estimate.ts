import { valuesOf } from "./secondary-index.js";
import { compareSortValues, type SortKind } from "./sort.js";

/**
 * Sample records per bin. A bin stands in for a run of neighbouring blocks, and within it a value's
 * occurrences are scaled up to the real block density. Too few records per bin and a value that is
 * in most blocks but rare in each one never shows up in the bin's handful of records, so it looks
 * like it prunes; too many and a value clustered inside one bin looks spread over the whole run.
 * Tuned on Scryfall (532 blocks) against the real per-block counts: 200 kept every field on the
 * right side of the 35% line from a sample of 2,000, 10,000 or 20,000 records.
 */
const SAMPLE_RECORDS_PER_BIN = 200;

/** One field's sampled counts, per bin. */
interface ValueCounts {
  count: number;
  /** Sum over bins of the expected share of that bin's blocks holding the value. */
  share: number;
}

/**
 * Predicts, from a uniform sample, the build's "barely prunes" number for a field's plain index: the
 * mean over the field's distinct values of the share of data files each value appears in, with the
 * records sorted by `sortField` (ADR-0013). `init` uses it to leave out indexes the build would warn
 * about; the wizard uses it to flag them as you pick.
 *
 * The sample is sorted by the sort field and cut into bins, each standing in for a run of real blocks.
 * Within a bin, a value seen `c` times among `n` sample records is scaled to its expected population
 * count, spread at random over the bin's blocks. Random placement inside a bin is the one assumption;
 * clustering between bins — the thing that makes an index prune — is measured, not assumed.
 */
export class BlockShareEstimator {
  private readonly bins: Record<string, unknown>[][];
  private readonly binBlocks: number;
  private readonly samplingRate: number;

  constructor(
    sample: Record<string, unknown>[],
    sortField: string,
    sortKind: SortKind,
    private readonly recordCount: number,
    private readonly blockCount: number,
  ) {
    const sorted = [...sample].sort((a, b) => compareSortValues(a[sortField], b[sortField], sortKind));
    const binCount = Math.max(1, Math.min(blockCount, Math.floor(sorted.length / SAMPLE_RECORDS_PER_BIN)));
    this.bins = Array.from({ length: binCount }, () => []);
    sorted.forEach((record, i) => this.bins[Math.floor((i * binCount) / sorted.length)]!.push(record));
    this.binBlocks = blockCount / binCount;
    this.samplingRate = sample.length / Math.max(1, recordCount);
  }

  /**
   * Estimated mean share of data files one value of `field` appears in, from 0 to 1. `cardinality` is
   * the field's distinct-value count over the whole input: values the sample missed are rare, and each
   * is counted as sitting in a single file. Undefined when the sample holds no value for the field.
   */
  meanShare(field: string, multi: boolean, cardinality: number): number | undefined {
    const perValue = new Map<string, ValueCounts>();
    for (const bin of this.bins) {
      const inBin = new Map<string, number>();
      for (const record of bin) {
        for (const value of valuesOf(record, field, multi)) {
          if (value === null || value === undefined) continue;
          const key = typeof value === "string" ? value : JSON.stringify(value);
          inBin.set(key, (inBin.get(key) ?? 0) + 1);
        }
      }
      for (const [key, c] of inBin) {
        // The value's expected occurrences across this bin's slice of the input, dropped at random into
        // the slice's blocks: the chance a given block receives none is (1 - 1/blocks)^occurrences.
        const occurrences = (c * this.recordCount) / (this.bins.length * bin.length);
        const blockShare = this.binBlocks <= 1 ? 1 : 1 - Math.pow(1 - 1 / this.binBlocks, occurrences);
        const entry = perValue.get(key) ?? { count: 0, share: 0 };
        entry.count += c;
        entry.share += blockShare / this.bins.length;
        perValue.set(key, entry);
      }
    }
    if (perValue.size === 0) return undefined;

    // The build averages over every distinct value, but a sample over-represents common values: a value
    // with n occurrences is sampled with probability 1 - (1 - rate)^n. Weighting each sampled value by
    // the inverse of that (Horvitz–Thompson) undoes the bias; values the sample missed entirely make up
    // the rest of `cardinality`, each in about one file.
    let weightedShare = 0;
    let weightedValues = 0;
    for (const { count, share } of perValue.values()) {
      const populationCount = count / this.samplingRate;
      const inclusion = this.samplingRate >= 1 ? 1 : 1 - Math.pow(1 - this.samplingRate, populationCount);
      weightedShare += share / inclusion;
      weightedValues += 1 / inclusion;
    }
    const unseen = Math.max(0, cardinality - weightedValues);
    return (weightedShare + unseen / this.blockCount) / (weightedValues + unseen);
  }
}
