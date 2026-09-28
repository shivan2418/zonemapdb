/**
 * The derived-field normalizers (ADR-0009), for normalizing a QUERY value the same way the build
 * normalized the column it targets. A `name_fold` column holds `fold(name)`, so a search box has to
 * send `normalize("fold", input)` or its trigrams won't line up with the index.
 *
 * This duplicates `zonemapdb-cli/src/normalize.ts` rather than importing it, like the other
 * cli/runtime pairs: the runtime stays dependency-free, and the CLI's test suite checks the two
 * produce identical output.
 */

/** Combining marks left behind by NFD, stripped to fold `û` → `u`. */
const COMBINING_MARKS = /\p{M}/gu;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const NORMALIZERS = {
  numeric(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = asString(value)?.trim();
    if (text === undefined || text.length === 0) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  },
  lowercase(value: unknown): string | null {
    const text = asString(value);
    return text === undefined ? null : text.toLowerCase();
  },
  trim(value: unknown): string | null {
    const text = asString(value)?.trim();
    return text === undefined || text.length === 0 ? null : text;
  },
  fold(value: unknown): string | null {
    const text = asString(value);
    if (text === undefined) return null;
    return text.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC").toLowerCase();
  },
};

export type NormalizerName = keyof typeof NORMALIZERS;

/**
 * Applies a derived-field normalizer. `null` means "no derivable value" — the build omits the derived
 * key for such records, so there is nothing a query with that value could match.
 */
export function normalize(using: "numeric", value: unknown): number | null;
export function normalize(using: "lowercase" | "trim" | "fold", value: unknown): string | null;
export function normalize(using: NormalizerName, value: unknown): string | number | null;
export function normalize(using: NormalizerName, value: unknown): string | number | null {
  return NORMALIZERS[using](value);
}
