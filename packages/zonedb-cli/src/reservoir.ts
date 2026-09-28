/** Fixed seed: the same input always yields the same sample, so the wizard's estimates are reproducible. */
const SEED = 0x5eed;

/** mulberry32 — a tiny seeded PRNG, all a reservoir sample needs. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A uniform random sample of up to `max` items from a stream of unknown length (Algorithm R), in
 * memory proportional to `max`. Uniform rather than the head of the stream, because a glob read in
 * filename order can make the head badly unrepresentative — all one state, all one year (#29).
 */
export class Reservoir<T> {
  private readonly items: T[] = [];
  private seen = 0;
  private readonly random = seededRandom(SEED);

  constructor(private readonly max: number) {}

  add(item: T): void {
    this.addWith(() => item);
  }

  /** `add`, building the item only if the sample keeps it — for items that cost something to make. */
  addWith(make: () => T): void {
    this.seen++;
    if (this.items.length < this.max) {
      this.items.push(make());
      return;
    }
    // The n-th item replaces a random slot with probability max / n.
    const slot = Math.floor(this.random() * this.seen);
    if (slot < this.max) this.items[slot] = make();
  }

  get sample(): T[] {
    return this.items;
  }
}
