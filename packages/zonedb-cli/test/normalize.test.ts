import { describe, expect, test } from "vitest";
import { normalize as runtimeNormalize } from "zonedb";
import { NORMALIZERS, isNormalizerName, normalizerNames } from "../src/normalize.js";

/**
 * The normalizers are a CLOSED set of domain-free pure functions. "Domain-free" is the load-bearing
 * property: `numeric` must not know that Magic's `*` means zero, or that some other dataset's `N/A`
 * means missing. Anything unparseable becomes `null` — "no derivable value" — and the derived key is
 * omitted rather than guessed at.
 */
describe("numeric", () => {
  const apply = (v: unknown) => NORMALIZERS.numeric.apply(v);

  test("declares number as the kind a field using it must be", () => {
    expect(NORMALIZERS.numeric.outputKind).toBe("number");
  });

  test("parses numeric strings, including negatives and decimals", () => {
    expect(apply("7")).toBe(7);
    expect(apply("10")).toBe(10);
    expect(apply("-1")).toBe(-1);
    expect(apply("3.5")).toBe(3.5);
    expect(apply("  42  ")).toBe(42);
  });

  test("passes numbers through untouched", () => {
    expect(apply(0)).toBe(0);
    expect(apply(12.5)).toBe(12.5);
  });

  test("anything not a finite number becomes null rather than a guess", () => {
    // Magic's power values: a domain rule maps `*` to 0, but zonedb must not assume that.
    expect(apply("*")).toBeNull();
    expect(apply("1+*")).toBeNull();
    expect(apply("∞")).toBeNull();
    expect(apply("?")).toBeNull();
    expect(apply("N/A")).toBeNull();
    expect(apply(null)).toBeNull();
    expect(apply(undefined)).toBeNull();
    expect(apply(true)).toBeNull();
  });

  test("the empty string is null, not zero — Number('') is 0 and that would be a silent lie", () => {
    expect(apply("")).toBeNull();
    expect(apply("   ")).toBeNull();
  });

  test("Infinity and NaN are not finite, so they are null too", () => {
    expect(apply("Infinity")).toBeNull();
    expect(apply(Number.POSITIVE_INFINITY)).toBeNull();
    expect(apply(Number.NaN)).toBeNull();
  });
});

describe("lowercase / trim / fold", () => {
  test("lowercase maps strings and rejects non-strings", () => {
    expect(NORMALIZERS.lowercase.outputKind).toBe("string");
    expect(NORMALIZERS.lowercase.apply("Rebecca Guay")).toBe("rebecca guay");
    expect(NORMALIZERS.lowercase.apply(7)).toBeNull();
  });

  test("trim strips surrounding whitespace, and a blank becomes null", () => {
    expect(NORMALIZERS.trim.apply("  Gladiator \n")).toBe("Gladiator");
    expect(NORMALIZERS.trim.apply("   ")).toBeNull();
  });

  test("fold removes case AND diacritics, so a plain-ASCII query can match accented text", () => {
    expect(NORMALIZERS.fold.apply("Æther Vial")).toBe("æther vial");
    expect(NORMALIZERS.fold.apply("Jörmungandr")).toBe("jormungandr");
    expect(NORMALIZERS.fold.apply("Lim-Dûl's Vault")).toBe("lim-dul's vault");
    expect(NORMALIZERS.fold.apply("SÉANCE")).toBe("seance");
  });

  test("fold is idempotent — folding a folded value changes nothing", () => {
    const once = NORMALIZERS.fold.apply("Lim-Dûl's Vault") as string;
    expect(NORMALIZERS.fold.apply(once)).toBe(once);
  });
});

describe("the registry itself", () => {
  test("isNormalizerName gates unknown names, so a typo in config fails loudly", () => {
    expect(isNormalizerName("numeric")).toBe(true);
    expect(isNormalizerName("Numeric")).toBe(false);
    expect(isNormalizerName("uppercase")).toBe(false);
  });

  test("every declared name has an entry, and every entry declares a queryable output kind", () => {
    for (const name of normalizerNames()) {
      const normalizer = NORMALIZERS[name];
      expect(normalizer).toBeDefined();
      expect(["string", "number", "boolean", "date"]).toContain(normalizer.outputKind);
    }
  });
});

/**
 * The runtime ships its own copy so consumers can normalize a query value the way the build
 * normalized the column. The two copies must agree on every input, or a folded search silently
 * misses rows the index holds.
 */
describe("parity with the runtime's normalize()", () => {
  const SAMPLES: unknown[] = [
    "Lim-Dûl the Necromancer", "Jötun Grunt", "Æther Vial", "  Sol Ring  ", "ÉCOLE", "İstanbul",
    "straße", "", "   ", "7", " -3.5 ", "1+*", "*", "∞", "Infinity", 0, 12.5, Number.NaN, null, undefined, true,
  ];

  test.each(normalizerNames())("%s", (name) => {
    for (const sample of SAMPLES) {
      expect(runtimeNormalize(name, sample)).toStrictEqual(NORMALIZERS[name].apply(sample));
    }
  });
});
