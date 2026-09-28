import { describe, expect, test } from "vitest";
import { normalize } from "../src/index.js";

/**
 * A derived column (ADR-0009) holds normalized values, so a query against it only lines up when the
 * query value went through the same normalizer. The runtime exports them for exactly that — a
 * consumer folding a search box must not have to re-implement `fold` and hope it matches.
 */
describe("normalize", () => {
  test("fold lowercases and strips diacritics, so a plain query matches accented text", () => {
    expect(normalize("fold", "Lim-Dûl the Necromancer")).toBe("lim-dul the necromancer");
    expect(normalize("fold", "Jötun Grunt")).toBe("jotun grunt");
  });

  test("fold leaves ligatures alone — mapping æ to ae is a language rule, not a universal one", () => {
    expect(normalize("fold", "Æther Vial")).toBe("æther vial");
  });

  test("lowercase and trim do only what they say", () => {
    expect(normalize("lowercase", "Rebecca Guay")).toBe("rebecca guay");
    expect(normalize("trim", "  Sol Ring  ")).toBe("Sol Ring");
    expect(normalize("trim", "   ")).toBeNull();
  });

  test("numeric reads numbers and refuses to guess", () => {
    expect(normalize("numeric", " 42 ")).toBe(42);
    expect(normalize("numeric", "*")).toBeNull();
    expect(normalize("numeric", "")).toBeNull();
  });

  test("string normalizers return null for non-strings, matching what the build writes", () => {
    expect(normalize("fold", 7)).toBeNull();
    expect(normalize("lowercase", null)).toBeNull();
  });
});
