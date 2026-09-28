import { describe, expect, test } from "vitest";
import { ZonemapDbError } from "../src/errors.js";

describe("ZonemapDbError — the single catchable error surface (ADR-0007 §4/§8)", () => {
  test("is an Error subclass carrying code/message/cause/url/status", () => {
    const cause = new TypeError("fetch failed");
    const error = new ZonemapDbError({
      code: "NETWORK",
      message: "zonemapdb: boom",
      cause,
      url: "/data/manifest.json",
      status: 500,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect(error.name).toBe("ZonemapDbError");
    expect(error.code).toBe("NETWORK");
    expect(error.message).toBe("zonemapdb: boom");
    expect(error.cause).toBe(cause);
    expect(error.url).toBe("/data/manifest.json");
    expect(error.status).toBe(500);
  });

  test("url/status are absent (not merely undefined) when not provided — e.g. LIMIT_EXCEEDED carries no url", () => {
    const error = new ZonemapDbError({ code: "LIMIT_EXCEEDED", message: "zonemapdb: too many" });

    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect("url" in error).toBe(false);
    expect("status" in error).toBe(false);
    expect(error.url).toBeUndefined();
    expect(error.status).toBeUndefined();
  });

  test("the code discriminant narrows in an exhaustive switch (one import, one instanceof)", () => {
    const error: unknown = new ZonemapDbError({ code: "CONFIG", message: "x" });
    if (!(error instanceof ZonemapDbError)) throw new Error("not a ZonemapDbError");
    const reacted = ((): string => {
      switch (error.code) {
        case "CONFIG":
        case "FORMAT_VERSION":
        case "DEPLOY_INTEGRITY":
        case "NETWORK":
        case "CORRUPT_DATA":
        case "LIMIT_EXCEEDED":
          return error.code;
      }
    })();
    expect(reacted).toBe("CONFIG");
  });
});
