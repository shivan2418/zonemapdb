# zonemapdb

## 0.8.0

### Minor Changes

- fc1567e: **Breaking: renamed from `zonedb` to `zonemapdb`** (ADR-0014). npm refused `zonedb` as too similar to existing packages, so 0.7.0 was never on npm. The packages are now `zonemapdb` and `zonemapdb-cli`, and the command is `zonemapdb`. `ZoneDbError`, `ZoneDbErrorCode` and `ZoneDbConfig` become `ZonemapDbError`, `ZonemapDbErrorCode` and `ZonemapDbConfig`. The config file is now `zonemapdb.config.json`, and the default output folders are `public/zonemapdb/` and `src/zonemapdb/`. Built data is unchanged.

## 0.7.0

### Minor Changes

- 26398fd: **Breaking: renamed from `blockdb` to `zonedb`** (ADR-0014), because npm refused `blockdb` as too similar to an existing package. The packages are now `zonedb` and `zonedb-cli`, and the command is `zonedb`. `BlockDbError`, `BlockDbErrorCode` and `BlockDbConfig` become `ZoneDbError`, `ZoneDbErrorCode` and `ZoneDbConfig`, and messages start with `zonedb:`. The config file is now `zonedb.config.json`, and the default output folders are `public/zonedb/` and `src/zonedb/`. Built data is unchanged (`formatVersion` 0), so existing deploys keep working. To migrate: swap the dependencies, rename the config file, run `zonedb build`, and update any `BlockDbError` imports.

## 0.6.0

### Minor Changes

- 3c224e9: `findMany({ where, scan: "block-order", limit })` accepts a rider-only `where`. It walks the data files in sort order and stops as soon as the page is full, for browse-style searches that are rider-only on purpose (a one-letter name search, a `not` filter alone). It needs a `limit` (a compile error without one) and no `orderBy` but the sort field (`NEEDS_PRUNING` otherwise). A rider few records match can still read most of the dataset, which is why this is opt-in. It replaces full-range tricks like `{ name: { gte: "" } }`. `NEEDS_PRUNING` messages now mention it.

## 0.5.0

### Patch Changes

- 98e5347: A first manifest fetch that fails (a 503 on page load, a dropped connection) is no longer cached: the next query fetches the manifest again instead of failing until the page reloads.
- ea2c7e5: A host with a single-page-app fallback (200 and `index.html` for a missing file) now gets the same stale-manifest recovery as a 404: an HTML response for a data file is `DEPLOY_INTEGRITY`, and for `manifest.json` it is `CONFIG`, instead of `CORRUPT_DATA`.
- 441bff2: The rider check now looks at values as well as operators. An empty `startsWith`/`endsWith`, an empty `hasEvery` and `isEmpty: false` match every block, so a `where` that relies on them alone now throws `NEEDS_PRUNING` (and `wherePrunes` returns `false`) instead of quietly downloading the whole dataset. A filter or operator set to `undefined` is left out, and no longer crashes `findMany`/`count` with a `TypeError`.

## 0.4.0

### Minor Changes

- a96b62e: New export `wherePrunes(where, schema): boolean`: the rule behind `NEEDS_PRUNING`, without the throw. An app that builds a `where` from UI input can check it against `db.x.getSchema()` and fall back (for example, add a sort-field range) instead of catching the error or re-implementing the rule. The `NEEDS_PRUNING` message now names the one rule the types can't see when it's the cause: `contains` prunes only with 3 or more characters. The query guide documents both.

## 0.3.1

### Patch Changes

- 7b900ac: Fix: a generated schema with a `json` field marked `absent` or `nullable` failed to type-check against the runtime (`Type '"json"' is not assignable to type 'FieldKind'`). Since 0.3.0 such fields reach the schema for their missing-value operators, but the runtime's `FieldKind` didn't include `json`. It now does. A `json` field takes only `isNull`/`isAbsent`/`exists`, and it can't be used in `orderBy`.

## 0.3.0

### Minor Changes

- bc2aab7: `findMany`, `count` and `get` take an optional `signal` (`findMany({ signal })`, `count(where, { signal })`, `get(id, { signal })`). When it fires, the query's pending block, index and sidecar fetches are cancelled and the call rejects with the new `BlockDbError` code `ABORTED`. Aborting one query never cancels the manifest fetch other queries share, and a cancelled query skips the stale-manifest retry. Meant for search-as-you-type, where each keystroke supersedes the previous query.
- fb1e1b6: **Breaking:** every field is now queryable, and an index only decides which filters _prune_ (ADR-0013, #30). A filter that can't narrow which files are read is a **rider**: `not`, `isNull`/`isAbsent`/`exists`, any filter on an unindexed field, and `contains`/`endsWith` without their index opt-in. Riders work alongside at least one filter that prunes. A `findMany` `where` made only of riders is a compile error and throws `BlockDbError` code `NEEDS_PRUNING` at runtime, instead of quietly reading the whole dataset (previously possible with `isNull`/`isAbsent`/`exists`). `orderBy` accepts any queryable field. The manifest gains a per-field `pruning` list, so deploys built with an older blockdb must be rebuilt (the runtime reports `FORMAT_VERSION`). `blockdb build` now warns when a plain index barely prunes, and the wizard's first step asks "Which filters need to be fast?".
- a4cd1f4: `blockdb build` streams end to end, so its memory no longer grows with the input (#28). Records are read, derived and drift-checked one at a time; the external sort now spills runs by size as well as count and merges them through a heap; each block is written as soon as it closes. Output is byte-identical to before. On real data, peak memory fell from 2.5 GB to 0.75 GB (532 MB input) and from 1.6 GB to 0.54 GB (257 MB input), and builds got faster. A build that fails part-way now leaves the previous output untouched. `inspect --config` streams the same way.
- 974b4f3: `blockdb init` streams its inference, so reading the whole input no longer means holding it in memory (#29). Each field keeps counts and a bounded distinct counter instead of its values: exact up to a million distinct values, estimated (±~1%) past that. On real data, peak memory fell from 1.47 GB to 0.19 GB (257 MB input) and from 1.33 GB to 0.37 GB (532 MB input), with identical configs. The wizard's live estimates now use a uniform sample of the whole input rather than its first 2,000 records, so a glob read in filename order no longer skews them.

### Patch Changes

- 341874e: The runtime recovers from a stale cached manifest after a redeploy (#32). On a host that caches every file (GitHub Pages sends `max-age=600`), a browser could reuse the previous deploy's `manifest.json`, which names files the new deploy removed, and queries failed with `DEPLOY_INTEGRITY` although the deploy was fine. The manifest is now fetched with `cache: "no-cache"`. When a file it names returns 404, the client refetches it with `cache: "reload"`; if the fresh manifest no longer names that file, it replaces the cached one and the query reruns once. `DEPLOY_INTEGRITY` is thrown only when the fresh manifest still names the missing file, and its message now mentions a stale cache as a possible cause. Concurrent queries share one refetch. A custom `fetch` should forward its `init` argument so the cache mode reaches the browser.

## 0.2.1

## 0.2.0

### Minor Changes

- 35a9d3c: Generated types now say when a field can be `null` (ADR-0012). `init` infers a new `nullable` flag beside `absent`, on every field. `nullable` types the field `T | null` and unlocks `isNull`, `absent` makes it optional and unlocks `isAbsent`, and either unlocks `exists`. Both flags now work on non-indexed fields too.

  `build` now fails when a record holds `null`, or lacks a key, where the config doesn't allow it, so an older config can report schema drift. Add the flag the error names, or run `blockdb init --reinfer`.

## 0.1.0

### Minor Changes

- First release. Query large datasets from any static host: the CLI partitions a dataset into blocks with zonemaps and a lazy inverted index, and the zero-dependency runtime fetches only the blocks a query needs.
