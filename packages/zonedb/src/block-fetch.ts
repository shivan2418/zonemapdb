import { fetchCompressedText, fetchText, parseCorruptible } from "./fetch-file.js";
import { compressionSuffix, decompressionFormat, type Compression } from "./types.js";

/** Past this many blocks, files nest under a 2-hex-char prefix subdir (ADR-0002 §8) — must match `blockRelPath` in the CLI's `block.ts` exactly, since no manifest field records which layout a deploy used. */
const HASH_PREFIX_THRESHOLD = 1000;
const HASH_PREFIX_LEN = 2;

/**
 * The served path of a block file, given the TOTAL block count (`manifest.blocks.length`) and
 * whether the deploy gzips block payloads (`manifest.dataset.gzip`). Exported (rather than kept
 * module-private) solely so the CLI's own test suite can assert this stays byte-for-byte
 * identical to `block.ts`'s build-side `blockRelPath` — the two are independent implementations
 * with no shared module, so an equivalence test is the only thing that catches drift between them.
 */
export function blockRelPath(hash: string, blockCount: number, compression: Compression): string {
  const filename = `${hash}.ndjson${compressionSuffix(compression)}`;
  return blockCount > HASH_PREFIX_THRESHOLD ? `blocks/${hash.slice(0, HASH_PREFIX_LEN)}/${filename}` : `blocks/${filename}`;
}

export async function fetchBlockRecords(
  basePath: string,
  hash: string,
  blockCount: number,
  compression: Compression,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const url = `${basePath}/${blockRelPath(hash, blockCount, compression)}`;
  const format = decompressionFormat(compression);
  const text =
    format === undefined
      ? await fetchText(url, "referenced", fetchImpl, signal)
      : await fetchCompressedText(url, "referenced", format, fetchImpl, signal);
  return parseCorruptible(url, () =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}
