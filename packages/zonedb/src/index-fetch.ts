import { fetchReferencedJson } from "./fetch-file.js";
import type { IndexChunkFile } from "./secondary-index.js";

export async function fetchIndexChunk(
  basePath: string,
  file: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<IndexChunkFile> {
  return (await fetchReferencedJson(`${basePath}/${file}`, fetchImpl, signal)) as IndexChunkFile;
}
