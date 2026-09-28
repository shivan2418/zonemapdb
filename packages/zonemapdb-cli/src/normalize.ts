import type { FieldKind } from "./types.js";

/**
 * The closed set of transforms a DERIVED field may apply to its source (ADR-0009).
 *
 * Closed and domain-free, both deliberately. Closed because the name is data in the config and the
 * manifest — an arbitrary user function would have to be serialized somewhere and executed, which a
 * JSON config and a zero-dependency runtime should not invite. Domain-free because a normalizer that
 * knew Magic's `*` means zero, or that some CSV's `N/A` means missing, would silently reinterpret
 * data it doesn't understand. Anything a normalizer cannot map is `null` — "no derivable value" —
 * and the derived key is then omitted from the record rather than filled with a guess.
 *
 * Domain rules stay the caller's job: preprocess the input, or add a column upstream.
 *
 * The runtime exports its own copy as `normalize()`, so consumers can normalize a query value to match
 * a derived column. `test/normalize.test.ts` checks the two agree; change them together.
 */
export interface Normalizer {
  /** The `kind` a field deriving with this normalizer must declare; `config.ts` enforces the match. */
  outputKind: FieldKind;
  /** The derived value, or `null` when this input has none. */
  apply(value: unknown): unknown;
}

/** Combining marks left behind by NFD, stripped to fold `û` → `u`. */
const COMBINING_MARKS = /\p{M}/gu;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function blankToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

export const NORMALIZERS = {
  /**
   * A finite number, or null. Strings are trimmed first. Note the empty-string trap: `Number("")` is
   * `0`, which would quietly turn every blank cell into a real zero and skew any range query over it.
   */
  numeric: {
    outputKind: "number",
    apply(value: unknown): unknown {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const text = asString(value)?.trim();
      if (text === undefined || text.length === 0) return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : null;
    },
  },

  /** Case-folded, for matching a lowercase query against mixed-case text. */
  lowercase: {
    outputKind: "string",
    apply(value: unknown): unknown {
      const text = asString(value);
      return text === undefined ? null : text.toLowerCase();
    },
  },

  /** Surrounding whitespace removed — the usual repair for hand-maintained CSV columns. */
  trim: {
    outputKind: "string",
    apply(value: unknown): unknown {
      const text = asString(value);
      return text === undefined ? null : blankToNull(text.trim());
    },
  },

  /**
   * Case AND diacritics removed, so a plain-ASCII query matches accented text (`Lim-Dûl` ← `lim-dul`).
   * Ligatures are deliberately left alone: NFD does not decompose `æ`, and mapping it to `ae` is a
   * language-specific rule, not a universal one.
   */
  fold: {
    outputKind: "string",
    apply(value: unknown): unknown {
      const text = asString(value);
      if (text === undefined) return null;
      return text.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC").toLowerCase();
    },
  },
} as const satisfies Record<string, Normalizer>;

export type NormalizerName = keyof typeof NORMALIZERS;

export function normalizerNames(): NormalizerName[] {
  return Object.keys(NORMALIZERS) as NormalizerName[];
}

export function isNormalizerName(value: string): value is NormalizerName {
  return Object.prototype.hasOwnProperty.call(NORMALIZERS, value);
}
