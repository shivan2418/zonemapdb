import { describe, expect, test } from "vitest";
import { formatCliError } from "../src/cli-error.js";

describe("formatCliError", () => {
  test("prefixes a bare message with the tool name", () => {
    expect(formatCliError(new Error("config not found"))).toBe("zonemapdb: config not found");
  });

  test("does not double the prefix on messages that already carry it", () => {
    // Most errors thrown inside the CLI already start with "zonemapdb:".
    expect(formatCliError(new Error("zonemapdb: schema drift — …"))).toBe("zonemapdb: schema drift — …");
  });

  test("stringifies non-Error throws as-is", () => {
    expect(formatCliError("boom")).toBe("boom");
  });
});
