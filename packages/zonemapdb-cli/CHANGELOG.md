# zonemapdb-cli

## 0.8.1

### Patch Changes

- ac875a9: An option a command doesn't know is now an error instead of being ignored. `zonemapdb build --out dist` used to build to the config's `output` without a word; it now fails and points at `zonemapdb build --help`. A bare `zonemapdb inspect` reads `zonemapdb.config.json`, as its help always said, instead of failing. `config.schema.json` no longer requires `indexed: true` beside `absent: true`, so editors stop flagging configs that `init` writes for unindexed fields.

## 0.8.0

### Minor Changes

- fc1567e: **Breaking: renamed from `zonedb` to `zonemapdb`** (ADR-0014). npm refused `zonedb` as too similar to existing packages, so 0.7.0 was never on npm. The packages are now `zonemapdb` and `zonemapdb-cli`, and the command is `zonemapdb`. `ZoneDbError`, `ZoneDbErrorCode` and `ZoneDbConfig` become `ZonemapDbError`, `ZonemapDbErrorCode` and `ZonemapDbConfig`. The config file is now `zonemapdb.config.json`, and the default output folders are `public/zonemapdb/` and `src/zonemapdb/`. Built data is unchanged.

## 0.7.0

### Minor Changes

- 26398fd: **Breaking: renamed from `blockdb` to `zonedb`** (ADR-0014), because npm refused `blockdb` as too similar to an existing package. The packages are now `zonedb` and `zonedb-cli`, and the command is `zonedb`. `BlockDbError`, `BlockDbErrorCode` and `BlockDbConfig` become `ZoneDbError`, `ZoneDbErrorCode` and `ZoneDbConfig`, and messages start with `zonedb:`. The config file is now `zonedb.config.json`, and the default output folders are `public/zonedb/` and `src/zonedb/`. Built data is unchanged (`formatVersion` 0), so existing deploys keep working. To migrate: swap the dependencies, rename the config file, run `zonedb build`, and update any `BlockDbError` imports.

## 0.6.0

## 0.5.0

### Minor Changes

- 080b26f: `--ends-with` and `--contains` are now the complete set when passed, like `--indexed`, so a text opt-in can be turned off from the CLI and the wizard (unticking `contains` in the wizard used to keep it on a re-run). Un-indexing a field with `--indexed` also drops its `endsWith`/`contains` instead of failing with "opts into contains but is not indexed".
- 0504680: A field's `values` union no longer requires `indexed: true`: every field is queryable since ADR-0013, and the union narrows an unindexed field's filters too. Following the build's "this index barely prunes, consider removing indexed" advice no longer breaks the next build, and the advice names any `endsWith`/`contains` that go with the index. `init --reinfer` and `--indexed` keep an existing union when a field is un-indexed.

### Patch Changes

- 6a0e1d5: A CSV/TSV number cell of `Infinity`, `-Infinity` or `1e999` now fails the read ("isn't a finite number") instead of being written to the block as `null`, where the manifest depended on whether the sort had spilled to disk. Schema drift also rejects a non-finite number.
- 455d6ec: `init`'s check for indexes that wouldn't prune is now judged against the sort field the config will actually use (`--sort-field`, or the one an existing config keeps on `--reinfer`), not the inferred one, and against the whole input's size when `--sample`/`--sample-size` reads only part of it. The "left X unindexed" note no longer appears for a field the existing config already had, or when `--indexed` gives the complete set.
- e440b32: The wizard's default indexes and its live "barely prunes" marks now come from the same sample, block size and whole-input size as `init`'s recommendation, so it no longer pre-ticks a field and then flags it. With `--sample-size` the wizard judges pruning against the whole input.

## 0.4.0

## 0.3.1

### Patch Changes

- 7b900ac: Fix: a generated schema with a `json` field marked `absent` or `nullable` failed to type-check against the runtime (`Type '"json"' is not assignable to type 'FieldKind'`). Since 0.3.0 such fields reach the schema for their missing-value operators, but the runtime's `FieldKind` didn't include `json`. It now does. A `json` field takes only `isNull`/`isAbsent`/`exists`, and it can't be used in `orderBy`.

## 0.3.0

### Minor Changes

- 9129d6a: `init` no longer recommends an index that wouldn't prune (#31). It estimates from a 5,000-record sample how many data files each candidate's average value would sit in under the recommended sort field. Above the build's 35% "barely prunes" line, it gives the slot to the next candidate and prints a note saying the field stays filterable as a rider. The wizard's "Fast filters" step marks such fields "barely prunes" and warns if you tick one.
- fb1e1b6: **Breaking:** every field is now queryable, and an index only decides which filters _prune_ (ADR-0013, #30). A filter that can't narrow which files are read is a **rider**: `not`, `isNull`/`isAbsent`/`exists`, any filter on an unindexed field, and `contains`/`endsWith` without their index opt-in. Riders work alongside at least one filter that prunes. A `findMany` `where` made only of riders is a compile error and throws `BlockDbError` code `NEEDS_PRUNING` at runtime, instead of quietly reading the whole dataset (previously possible with `isNull`/`isAbsent`/`exists`). `orderBy` accepts any queryable field. The manifest gains a per-field `pruning` list, so deploys built with an older blockdb must be rebuilt (the runtime reports `FORMAT_VERSION`). `blockdb build` now warns when a plain index barely prunes, and the wizard's first step asks "Which filters need to be fast?".
- a4cd1f4: `blockdb build` streams end to end, so its memory no longer grows with the input (#28). Records are read, derived and drift-checked one at a time; the external sort now spills runs by size as well as count and merges them through a heap; each block is written as soon as it closes. Output is byte-identical to before. On real data, peak memory fell from 2.5 GB to 0.75 GB (532 MB input) and from 1.6 GB to 0.54 GB (257 MB input), and builds got faster. A build that fails part-way now leaves the previous output untouched. `inspect --config` streams the same way.
- 974b4f3: `blockdb init` streams its inference, so reading the whole input no longer means holding it in memory (#29). Each field keeps counts and a bounded distinct counter instead of its values: exact up to a million distinct values, estimated (±~1%) past that. On real data, peak memory fell from 1.47 GB to 0.19 GB (257 MB input) and from 1.33 GB to 0.37 GB (532 MB input), with identical configs. The wizard's live estimates now use a uniform sample of the whole input rather than its first 2,000 records, so a glob read in filename order no longer skews them.

## 0.2.1

### Patch Changes

- 37ce229: `init --reinfer` now refreshes only what it learned from the data (kinds, `absent`/`nullable`, list fields, value sets, added or removed fields) and keeps your choices: the sort field, primary key, indexed fields, `endsWith`/`contains`, compression and block sizes. Previously it reset the sort field and indexed set to inferred defaults and dropped `compression`. Re-running plain `init` on an existing config also keeps `compression` now. Schema-drift errors from `build` list every drifting field at once, grouped by the fix.

## 0.2.0

### Minor Changes

- 35a9d3c: Generated types now say when a field can be `null` (ADR-0012). `init` infers a new `nullable` flag beside `absent`, on every field. `nullable` types the field `T | null` and unlocks `isNull`, `absent` makes it optional and unlocks `isAbsent`, and either unlocks `exists`. Both flags now work on non-indexed fields too.

  `build` now fails when a record holds `null`, or lacks a key, where the config doesn't allow it, so an older config can report schema drift. Add the flag the error names, or run `blockdb init --reinfer`.

### Patch Changes

- 1eb99c7: `blockdb build` warns on every `compression: "brotli"` build: it needs a host that serves `.br` files with `Content-Encoding: br`. On raw-bytes hosts such as GitHub Pages, Chrome can't decode them yet; use `gzip` there.

## 0.1.0

### Minor Changes

- First release. Query large datasets from any static host: the CLI partitions a dataset into blocks with zonemaps and a lazy inverted index, and the zero-dependency runtime fetches only the blocks a query needs.
