import { describe, expect, test } from "vitest";
import { Reservoir } from "../src/reservoir.js";

describe("Reservoir", () => {
  test("keeps everything while the stream is shorter than the sample", () => {
    const r = new Reservoir<number>(10);
    for (let i = 0; i < 5; i++) r.add(i);
    expect(r.sample).toEqual([0, 1, 2, 3, 4]);
  });

  test("samples the whole stream, not its head", () => {
    // A stream ordered like a filename-ordered glob: the head alone would be all "AK".
    const r = new Reservoir<number>(1000);
    for (let i = 0; i < 100_000; i++) r.add(i);
    expect(r.sample).toHaveLength(1000);
    const mean = r.sample.reduce((a, b) => a + b, 0) / r.sample.length;
    expect(mean).toBeGreaterThan(45_000);
    expect(mean).toBeLessThan(55_000);
    expect(r.sample.filter((i) => i >= 90_000).length).toBeGreaterThan(50);
  });

  test("is deterministic, so the wizard's estimates are reproducible", () => {
    const draw = () => {
      const r = new Reservoir<number>(50);
      for (let i = 0; i < 10_000; i++) r.add(i);
      return r.sample;
    };
    expect(draw()).toEqual(draw());
  });
});
