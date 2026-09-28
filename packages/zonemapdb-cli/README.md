# zonemapdb-cli

Build tool for [zonemapdb](https://www.npmjs.com/package/zonemapdb): infer → partition → index → codegen, plus the config wizard. A Node-only devDependency — install it alongside the runtime `zonemapdb` package, never in production.

## Quickstart

```bash
pnpm add zonemapdb && pnpm add -D zonemapdb-cli
pnpm exec zonemapdb init data/books.ndjson   # interactive wizard, or fully flag-driven with --yes
pnpm exec zonemapdb build                    # → public/zonemapdb/ (deploy this) + src/zonemapdb/ (commit this)
```

`init` is the only place inference happens, and it reads **every record by default** — it writes a single committed `zonemapdb.config.json`. `build` is headless (no TTY, safe in CI): it replays the config's baked schema — never re-infers — and fails loudly if your data has drifted from it.

### Commands

- **`init [input]`** — interactive wizard, or `--yes` plus flags (no prompts, scriptable). Detects the input format, infers a schema, recommends a sort field and default indexed set, and writes `zonemapdb.config.json`. Flags:
  - input: `--format` (`ndjson`, `json`, `csv`, `tsv`), `--delimiter`, `--records` (the dot-path to the records in a JSON file), `--collection`
  - schema: `--sort-field`, `--pk`, `--indexed`, `--ends-with`, `--contains`
  - inference: `--sample`, `--sample-size <n>`, `--full-scan` (the default, spelled out), `--reinfer`
  - output: `--output` (default `public/zonemapdb`), `--client-out` (default `src/zonemapdb`), `--base-path` (default derived from `--output`), `--block-bytes` (default 2 MiB), `--index-chunk-bytes` (default ~45 KB)
  - other: `--yes`, `--config` (where to write the config)
- **`build`** — reads the committed config, blocks and indexes the data, writes the served tree to the config's `output` and regenerates the typed client in its `clientOut`. The one flag is `--config`. It builds into a staging directory next to `output` and swaps it in only when complete, so a failed build leaves the previous tree in place.
- **`inspect`** — read-only report over a config or a built directory: block and index sizes, cost estimates and warnings, without rebuilding. Flags: `--config` (default `zonemapdb.config.json`) or `--dir`, and `--json`.

Every command takes `-h`/`--help`, and an option a command doesn't know is an error.

Every wizard choice is also a CLI flag (nothing wizard-only), so `init --yes` with the right flags reproduces exactly what the wizard would have written — config generation is fully scriptable for CI.

### When the data changes: `init --reinfer`

`build` fails with a schema-drift error when the data no longer matches the config: a new `null`, a missing key, a value of the wrong kind. The error lists every affected field at once. `init --reinfer` re-reads the data and refreshes only what `init` learned from it: field kinds, `absent`/`nullable`, list fields, value sets, and fields added to or removed from the data. It keeps every choice you made: the sort field, the primary key, which fields are indexed, `endsWith`/`contains`, compression, block sizes, derived fields, `valuesType` (while the field still has `values`) and `tsType`/`tsImport` (while the field is still `json`). New fields get the same defaults a first run gives them, and flags override everything.

`--indexed`, `--ends-with` and `--contains` each take a comma-separated list, and each list is the complete set for that flag, not an addition to what the config already has. So `--contains title` turns `contains` off on every other field, and a field left out of `--indexed` also loses its `endsWith`/`contains`, which need an index.

### Inference reads everything by default

`init` decides the baked schema, and a schema that is wrong about your data is the expensive kind of wrong: a value union missing a value that first appears at row 40,000, a field absent from the first 1000 rows, a cardinality that misprices an index or picks the wrong sort field. So `init` reads the whole input. It streams, like `build`: it keeps counts per field rather than the records, so its memory stays flat however large the input. Distinct values are counted exactly up to a million per field and estimated (±~1%) past that.

Pass `--sample` (or `--sample-size <n>`) for a fast look at a large file. It reads only the leading records, so it trades accuracy for time: on a glob read in filename order, the head can be all one file. It is opt-in, not the default.

### Choosing the sort field

The single biggest lever on query cost. Records are range-partitioned by this one field, so it decides **which records get stored next to each other**: a filter on the sort field reads a handful of data files, while a filter on anything else may read most of them. Pick the field your most common filter or ordering actually uses.

`number`, `date` and `string` fields are all eligible. A sorted **string** field additionally gets `startsWith` for free — a prefix is a contiguous range of the split-points already in the manifest, so it needs no index chunk fetch at all. On a 25k-record dataset (29 files), `startsWith("Light")` reads 26 of 29 files when sorted by a timestamp, and 1 of 29 when sorted by `name`.

The wizard measures this rather than guessing. It asks what you filter on **first**, then — for each candidate sort field — orders your actual records by it, cuts them into block-sized bins, and counts how many bins each of your filter values lands in. Each candidate shows what share of your data files a query would read, and it warns when your filters would read over half of it on average. Nothing keys off field names.

`init --yes`, with no filter selection to measure against, falls back to the highest-cardinality `number`/`date` field that every record has, with a single value. A `string` field is picked only when there is no such number or date field. That spreads blocks evenly but is blind to what you query, so a bulk-maintenance timestamp can win — check it, or use the wizard.

### Which fields `init` indexes

`init` recommends a small default set of indexed fields: the primary key and list fields (both must be indexed), plus up to three facet-like fields (more than one distinct value, and at most one per ten records) ranked by how many distinct values they have. Since every field is filterable anyway (as a rider, next to a filter that prunes), an index is only worth building if it narrows which files a query reads. So `init` also checks each candidate. It sorts a random sample of 5,000 records drawn from the whole input by the recommended sort field and estimates how many data files the field's average value would sit in. A field above 35% (the same line where `build` warns "this index barely prunes") is passed over, its slot goes to the next candidate, and `init` prints why:

```
zonemapdb: init left "color" unindexed — sorted by "id", its average value would sit in about 100% of the data files, ...
```

Add `"indexed": true` (or `--indexed`) if an app filters on that field **by itself**: a `where` made only of riders is rejected, and an index counts as a pruning constraint even when it prunes badly. The wizard's "Fast filters" step marks the same fields "barely prunes" as you pick. With fewer than 8 data files there's nothing to judge, and cardinality alone decides.

### Text-search opt-ins have real cost

`equals`, `in` and `startsWith` are free on any indexed string field. `endsWith` (reversed index) and `contains` (trigram index) are per-field opt-ins that each build an extra structure, and `build` warns in two distinct ways:

- **"bigger than the data"** (`contains` only) — the trigram index exceeds the raw column it indexes. A size complaint.
- **"barely prunes"** (both, and plain indexes too) — the average lookup resolves to most of your data files, so a query using it still reads most of the dataset. Typical of identifier, URL, and near-constant fields, whose substrings spread evenly across every file. Substring-searching a UUID column costs a full extra index and buys nothing.

An index can be small and useless, or large and worth it, so the two warnings are independent. Text matching is also **case-sensitive**; for case- and accent-insensitive search, see [derived fields](#derived-fields).

### Derived fields

A derived field is a column `build` computes from another field before partitioning (ADR-0009). After that it behaves like any other column: indexable, sortable, typed. The normalizers are a closed set: `fold` (lowercase, diacritics stripped), `lowercase`, `trim` and `numeric`. A value a normalizer can't map, like `numeric` on `"*"`, leaves the derived key absent rather than guessing.

```json
"title_fold": { "kind": "string", "indexed": true, "contains": true, "derive": { "from": "title", "using": "fold" } },
"year_num":   { "kind": "number", "indexed": true, "absent": true, "derive": { "from": "year", "using": "numeric" } }
```

`title_fold` gives case- and accent-insensitive search; normalize the query with the runtime's `normalize("fold", input)` so it matches ([runtime README](https://www.npmjs.com/package/zonemapdb#case-insensitive-search-fold-at-build-time)). `year_num` gives numeric ranges over a column stored as text (`"1999"`, `"n/a"`), and is absent where the text isn't a number. `derive.from` must be a declared, non-derived field, and the declared `kind` must match the normalizer's output.

### Typing json payloads

Fields of `kind: "json"` are payload-only: stored and returned in full, but never filtered (every other field is). Codegen types them as `unknown`, which is honest but means the part of the record holding your nested data is the one part that isn't typed. Declare a `tsType` to fix that:

```jsonc
{
  "cover": {
    "kind": "json",
    "tsType": "CoverImage",
    "tsImport": "import type { CoverImage } from \"../types/books.js\";"
  },
  "prices": { "kind": "json", "tsType": "Record<string, string | null>" }
}
```

```ts
book.cover?.url;  // string | undefined — checked, not `unknown`
book.cover?.ulr;  // compile error
```

- `tsType` is any type expression (`CoverImage`, `Author[]`, a `Record<…>`), emitted verbatim.
- `tsImport` is a complete import statement, emitted above the interface. Identical statements across fields are emitted once, so several payload fields can share one module. **The path is relative to `clientOut`** (default `src/zonemapdb/`), not to the config.
- Payload fields stay **optional** even with a declared type. zonemapdb never tracks presence for `json` fields, so it can't promise the key exists.
- `init --reinfer` preserves both while the field stays `kind: "json"` — they're the one part of a field config inference can't produce.

This is an **unchecked assertion**. zonemapdb relays the payload verbatim and never validates it against the type you declared; keeping the declaration true of your data is your job, exactly as with a database driver's row type. Validation stays out of scope.

See the [project README](https://github.com/shivan2418/zonemapdb#readme) for the full pitch and design, and [`examples/`](https://github.com/shivan2418/zonemapdb/tree/master/examples) for two complete example apps built with this CLI. For querying, see the [query guide](https://github.com/shivan2418/zonemapdb/blob/master/docs/query-guide.md).

## License

MIT
