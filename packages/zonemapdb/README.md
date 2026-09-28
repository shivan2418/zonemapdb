# zonemapdb

Query large datasets from any static host: no backend, no WASM, no HTTP Range requests.

This is the **runtime** package: a zero-third-party-dependency, ESM-only browser client that fetches a manifest and the handful of small block/index files a query actually needs, and returns fully-typed records. It has no `bin` and does no building — pair it with [`zonemapdb-cli`](https://www.npmjs.com/package/zonemapdb-cli) (a devDependency) to partition your data and generate the typed client this package powers.

See the [project README](https://github.com/shivan2418/zonemapdb#readme) for the full pitch, design, and alternatives comparison.

## Quickstart

```bash
pnpm add zonemapdb && pnpm add -D zonemapdb-cli
npx zonemapdb init data/movies.ndjson   # a guided wizard reads your data, recommends
                                      #   what to index, and writes zonemapdb.config.json
npx zonemapdb build                     # → public/zonemapdb/ (deploy this) + src/zonemapdb/ (commit this)
```

```ts
import { connect } from "./zonemapdb/client";

const db = connect();
const { records, hasMore } = await db.movies.findMany({
  where: { year: { gte: 2000 }, rating: { gt: 8 } },
  orderBy: { rating: "desc" },
  limit: 20,
});
```

`db.<collection>` is a real, named member with go-to-definition and intellisense on both the field and its available operators — the type system offers exactly the operators each field's type allows, and rejects a query none of whose filters can narrow which files are read (see [Riders](https://github.com/shivan2418/zonemapdb/blob/master/docs/query-guide.md#riders-filters-that-dont-narrow-the-read)). See [`examples/`](https://github.com/shivan2418/zonemapdb/tree/master/examples) in the repo for two complete, working example apps (movie catalog, product lookup) that build → deploy → query in a real browser.

## Querying

The full reference, with every operator, sorting, pagination, counting, errors and what each query costs, is the **[query guide](https://github.com/shivan2418/zonemapdb/blob/master/docs/query-guide.md)**. Two things worth knowing up front:

### List fields

A multi-valued field (`"multi": true`) takes list operators instead of scalar ones:

```ts
await db.books.findMany({ where: { tags: { some: "poetry" } } });                       // any tag is poetry
await db.books.findMany({ where: { tags: { hasEvery: ["poetry", "travel"] } } });       // has both
await db.books.findMany({ where: { tags: { every: { in: ["poetry", "travel"] } } } });  // no other tags; [] passes
await db.books.findMany({ where: { tags: { isEmpty: true } } });                        // []
// Operators on one field AND together, so exactly [poetry, travel] is:
await db.books.findMany({ where: { tags: { hasEvery: ["poetry", "travel"], every: { in: ["poetry", "travel"] } } } });
```

A record whose list is missing or `null` matches none of them, including `isEmpty`.

### Case-insensitive search: fold at build time

Every string operator compares **exactly**, against an index built from the stored values, so on Title Case data `contains: "atlas"` finds nothing. Folding only the query can't fix that. Instead, add a **derived field** that the build computes with the `fold` normalizer (lowercase, accents stripped):

```json
"title_fold": { "kind": "string", "indexed": true, "contains": true, "derive": { "from": "title", "using": "fold" } }
```

Then fold the query the same way with the exported `normalize`, which is the same function the build uses:

```ts
import { normalize } from "zonemapdb";

const q = normalize("fold", input) ?? "";
await db.books.findMany({ where: { title_fold: { contains: q } } }); // "cafe" finds "Café Atlas"
```

`title` itself is untouched, so you still display it, sort by it and match it exactly. The other normalizers are `lowercase`, `trim` and `numeric`.

## License

MIT
