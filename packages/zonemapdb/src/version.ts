/**
 * The on-disk/runtime compatibility contract (ADR-0005): `formatVersion` = the
 * package major. One number governs both data-format and code-contract
 * compatibility — a manifest whose major differs from this runtime's is
 * rejected with `FORMAT_VERSION` when the manifest loads. Keep in sync with
 * package.json's major (a test asserts exactly that).
 */
export const FORMAT_VERSION = 0;
