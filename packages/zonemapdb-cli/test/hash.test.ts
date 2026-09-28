import { describe, expect, test } from "vitest";
import { contentHash } from "../src/hash.js";

describe("contentHash", () => {
  test("is deterministic for identical content", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  test("differs for different content", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("hello there"));
  });

  test("returns a short lowercase hex string", () => {
    const hash = contentHash("some block content\n");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
