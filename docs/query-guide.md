# Querying zonemapdb

A complete guide to the query API: every operator, what each method returns, and what a query costs. For setup, see the [README](../README.md). For how the build decides what's queryable, see the [zonemapdb-cli README](../packages/zonemapdb-cli/README.md).

- [The example dataset](#the-example-dataset)
- [Connecting](#connecting)
- [The four methods](#the-four-methods)
- [Filtering rules](#filtering-rules)
- [Riders: filters that don't narrow the read](#riders-filters-that-dont-narrow-the-read)
- [Which operators a field gets](#which-operators-a-field-gets)
- [Strings](#strings)
- [Numbers and dates](#numbers-and-dates)
- [Booleans](#booleans)
- [Missing values: null and absent](#missing-values-null-and-absent)
- [`not`](#not)
- [List fields](#list-fields)
- [No OR: what to do instead](#no-or-what-to-do-instead)
- [Sorting](#sorting)
- [Pagination](#pagination)
- [Counting](#counting)
- [Looking up by id](#looking-up-by-id)
- [Cancelling a query](#cancelling-a-query)
- [Running queries in a Web Worker](#running-queries-in-a-web-worker)
- [What a query costs](#what-a-query-costs)
- [Errors](#errors)
- [What the compiler catches](#what-the-compiler-catches)

## The example dataset

Every example below queries one collection, `books`, built from records like this:

```json
{ "id": "b-00042", "title": "River Clock", "author": "Erin Walsh", "published": "2005-01-18",
  "pages": 526, "inStock": true, "language": "fr", "tags": ["history", "poetry"],
  "rating": 4.2, "details": { "isbn": "978-1000000042" } }
```

`rating` is `null` in some records and missing entirely in others. The config's `schema` block:

```json
{
  "sortField": "title",
  "pk": "id",
  "fields": {
    "id":         { "kind": "string", "indexed": true },
    "title":      { "kind": "string" },
    "title_fold": { "kind": "string", "indexed": true, "contains": true, "derive": { "from": "title", "using": "fold" } },
    "author":     { "kind": "string", "indexed": true, "endsWith": true },
    "published":  { "kind": "date", "indexed": true },
    "pages":      { "kind": "number", "indexed": true },
    "rating":     { "kind": "number", "indexed": true, "absent": true, "nullable": true },
    "inStock":    { "kind": "boolean" },
    "language":   { "kind": "string", "indexed": true, "values": ["de", "en", "es", "fr"] },
    "tags":       { "kind": "string", "indexed": true, "multi": true,
                    "values": ["fantasy", "fiction", "history", "mystery", "poetry", "romance", "science", "travel"] },
    "details":    { "kind": "json" }
  }
}
```

`zonemapdb init` infers almost all of this from the data; you pick the sort field, the primary key and which filters need to be fast (the indexed fields). `inStock` isn't indexed: it can still be filtered, as a [rider](#riders-filters-that-dont-narrow-the-read).

## Connecting

`zonemapdb build` generates `src/zonemapdb/client.ts`. Import `connect` from it:

```ts
import { connect } from "./zonemapdb/client";

const db = connect();
```

With no arguments it fetches from the `basePath` baked in at build time. That's the config's `basePath`, or else the `output` folder with any leading `public/` dropped, so the default `public/zonemapdb` becomes `/zonemapdb`. Every option can be overridden:

```ts
const db = connect({
  basePath: "/data/books", // where the built output is deployed
  fetch: myFetch,          // any fetch-compatible function: retries, auth headers, tests
  maxResults: 50_000,      // the result ceiling (default 10,000), see Pagination
});
```

If the build pre-compressed the manifest, the generated `connect()` also sets `manifestCompression` to match. Don't override it unless you've changed how the deploy is compressed.

`db.books` is a real, named property, so go-to-definition and autocomplete work on the collection, its fields and each field's operators.

## The four methods

| Method | Returns | Notes |
|---|---|---|
| `findMany({ where?, orderBy?, limit?, offset? })` | `{ records, hasMore, total? }` | Full records, including payload-only fields. |
| `count(where?)` | `{ count, exact }` | An upper bound that never downloads a data file. See [Counting](#counting). |
| `get(id)` | the record, or `null` | Only exists when the config names a `pk`. |
| `getSchema()` | the schema descriptor | Fields, kinds and enabled operators, for building UIs. |

All four are async.

## Filtering rules

A `where` maps field names to filters, and a filter maps operator names to values:

```ts
await db.books.findMany({
  where: { language: { equals: "fr" }, pages: { gte: 300, lte: 400 } },
});
```

- **Everything ANDs.** Every field in `where` must match, and every operator on one field must match. There is no OR. See [No OR](#no-or-what-to-do-instead).
- **Every field is queryable**, except fields of kind `json`, which are carried in records but never filtered by value. A `json` field marked `nullable` or `absent` still gets the missing-value operators (`isNull`, `isAbsent`, `exists`). Indexing a field doesn't decide whether you can filter on it; it decides whether that filter makes the query cheaper.
- **Every query needs one filter that narrows which files are read.** Filters that can't are [riders](#riders-filters-that-dont-narrow-the-read): they're fine alongside one that can, and rejected on their own.
- **Operators come from the field's type and flags.** The type system offers exactly those, so a typo or a range on a text field is a compile error.

## Riders: filters that don't narrow the read

Every filter is one of two kinds:

- A **pruning** filter narrows which data files a query downloads. Filters on the sort field prune, and so do filters an index can answer: `equals`, `in` and `startsWith` on an indexed string, `equals`, `in` and ranges on an indexed number or date, `equals` on an indexed boolean, `endsWith` and `contains` when you opted into their indexes, and the list operators.
- A **rider** only checks the records that a pruning filter already downloaded. `not` is always a rider, and so are `isNull`, `isAbsent` and `exists`. So is every filter on an unindexed field, and any operator the field has no index for, such as `contains` without `"contains": true` (or with fewer than three characters, which is too short for the trigram index).

Riders are exact: they only ever change which records come back, never whether the right ones do. They're free, too: they cost nothing at build time and add nothing to the download beyond the files the pruning filter already chose.

```ts
// language prunes; inStock (unindexed) and the author test ride along
await db.books.findMany({
  where: { language: { equals: "fr" }, inStock: { equals: true }, author: { not: "Erin Walsh" } },
});
```

A `where` made only of riders would have to download every file, so it's rejected. With the generated types that's a compile error. For a `where` built at runtime, such as from UI input, it's a `ZonemapDbError` with code `NEEDS_PRUNING`, whose message names the fields that can prune. `count` accepts riders on their own, because it never downloads data files.

```ts
await db.books.findMany({ where: { inStock: { equals: true } } }); // ✗ only a rider
await db.books.count({ inStock: { equals: true } });               // ✓ an upper bound, no data files read
```

**Checking a `where` built from UI input.** The compiler can't see the rules that depend on a value. `contains` prunes only with **3 or more characters**, because a shorter needle has no trigram to look up. An empty `startsWith` or `endsWith` (on any field, the sort field included) and an empty `hasEvery` match every block, so they ride too. So does `isEmpty: false`, which the types already reject but a `where` built at runtime can still hold. So `{ title_fold: { contains: "ab" } }` or `{ tags: { hasEvery: [] } }` (no chip selected) type-checks, then throws `NEEDS_PRUNING` at runtime if nothing else in the `where` prunes. To fall back instead of catching the error, ask `wherePrunes` first. It applies exactly the rule `findMany` enforces, against the schema you pass. `findMany` checks against the deployed manifest's schema, so the two agree as long as the bundled client and the deploy come from the same build:

```ts
import { normalize, wherePrunes } from "zonemapdb";

const where = { title_fold: { contains: normalize("fold", userInput) ?? "" } };
const { records } = wherePrunes(where, db.books.getSchema())
  ? await db.books.findMany({ where, limit: 20 })
  : // too short for the trigram index: narrow by the sort field as well
    await db.books.findMany({ where: { ...where, title: { startsWith: userInput } }, limit: 20 });
```

`wherePrunes` answers "would `findMany` accept this?", not "does this narrow the read?". An empty or missing `where` returns `true`, because an unfiltered `findMany` is allowed: with a `limit` and no `orderBy` other than the sort field, it reads blocks in sort order and stops once the page is full. Otherwise it reads every block (see [Sorting](#sorting) for exactly when). So if your UI can clear every filter, check for the empty case yourself before deciding whether to add a range.

A filter or operator set to `undefined` is left out, the same as if it weren't written: `{ set: chosen ? { equals: chosen } : undefined }` filters on `set` only when something is chosen. `findMany`, `count` and `wherePrunes` all drop these first, so a `where` whose filters are all `undefined` is the empty `where`.

**Scanning in block order.** Some searches really are rider-only: "colorless cards", a one-letter name search, or a `not` filter alone. For those, opt into a scan. It walks the data files in sort order and stops as soon as the page is full:

```ts
const { records, hasMore } = await db.books.findMany({
  where: { inStock: { equals: true } }, // a rider alone
  scan: "block-order",
  limit: 20,
});
```

A scan needs a `limit`, and its order has to be the order the files are stored in: no `orderBy`, or `orderBy` on the sort field alone. Without those it couldn't stop early. The compiler rejects a missing `limit`. The runtime rejects, with `NEEDS_PRUNING`, an `orderBy` on another field, one with several keys, and an `orderBy` on the sort field when some records have no sort value (see [Sorting](#sorting)). The cost depends on the data. A rider most records match fills the page from the first file or two. One that few records match can read most of the dataset before the page fills, or before it runs out. So use a scan where either outcome is acceptable, like a browse view, and keep a pruning filter wherever you have one. There's no need for a fake range such as `{ title: { gte: "" } }` to get past the rider check; that costs the same and hides the intent.

**When to index a field.** Index it when a filter on it should narrow the read by itself. Leave it unindexed when it's only ever combined with a more selective filter, or when its values are spread across every file anyway: a boolean, or a house number in an address list sorted by street. `zonemapdb build` warns about an index whose average value appears in most files, because that index costs build output and saves nothing.

## Which operators a field gets

| Field | Operators | Of those, prune |
|---|---|---|
| Sort field, number or date | `equals` `in` `gt` `gte` `lt` `lte` `not` | all but `not` |
| Sort field, string | the same, plus `startsWith` `endsWith` `contains` | all but `not` `endsWith` `contains` (an empty `startsWith` rides) |
| String | `equals` `in` `startsWith` `endsWith` `contains` `not` | if indexed: `equals` `in` `startsWith`, plus `endsWith` / `contains` if opted in (`contains` with 3+ characters; an empty `startsWith` / `endsWith` rides) |
| Number or date | `equals` `in` `gt` `gte` `lt` `lte` `not` | if indexed: all but `not` |
| Boolean | `equals` `not` | if indexed: `equals` |
| List (`"multi": true`, always indexed) | `some` `every` `hasEvery` `isEmpty` | `some` / `every` through their element filter, `hasEvery` with at least one value, `isEmpty: true` |
| Not a list or the sort field, with `"nullable": true` | also `isNull` `exists` | none |
| Not a list or the sort field, with `"absent": true` | also `isAbsent` `exists` | none |
| `json`, with `"nullable"` or `"absent"` | only the missing-value operators above | none |

## Strings

`equals`, `in` and `startsWith` are case-sensitive, and prune on an indexed string field:

```ts
await db.books.findMany({ where: { author: { equals: "Erin Walsh" } } });
await db.books.findMany({ where: { author: { in: ["Erin Walsh", "Hana Sato"] } } });
await db.books.findMany({ where: { author: { startsWith: "Er" } } });
```

**The sort field also gets ranges.** String ranges compare lexicographically (by UTF-16 code unit), which is only meaningful on the sort field, where it matches the physical order of the data. A range on the sort field is also the cheapest query there is:

```ts
await db.books.findMany({ where: { title: { gte: "Glass", lt: "H" } } });
```

Other string fields never get ranges, because `gte: "2"` on a column of numeric-looking strings would silently drop `"10"`. Give that data `kind: "number"` instead, or derive a number column (below).

**`endsWith` and `contains` work on every string field; opting in makes them prune.** Without an opt-in they're riders. `"endsWith": true` builds a reversed index and `"contains": true` a trigram index, which cost build time and deploy size, so opt in only where the filter has to narrow the read by itself:

```ts
await db.books.findMany({ where: { author: { endsWith: "Walsh" } } });
await db.books.findMany({ where: { title_fold: { contains: "atlas" } } });
```

`zonemapdb build` warns when one of these indexes barely prunes, which is typical of identifiers and near-constant fields.

**Value unions.** When a string field has few distinct values, `init` records them in `values`. Codegen then narrows `equals`, `in`, `not`, `hasEvery` and the element filters of `some` and `every` to that union, so `language: { equals: "xx" }` is a compile error and your editor autocompletes the valid values. `startsWith`, `endsWith` and `contains` stay plain `string`, because a fragment of a value isn't itself a value. The generated `schema.ts` exports the union by name, collection plus field (`BooksLanguage` here), which is handy for building a picker. Set `"valuesType": "Language"` on the field to name it yourself; fields with the same `valuesType` share one union. Delete `values` from the config to widen the field back to `string`.

### Case- and accent-insensitive search

Matching is exact, so `contains: "cafe"` won't find "Café". Fix it at build time: derive a folded copy of the field (`"derive": { "from": "title", "using": "fold" }`, see the config above), then fold the user's input the same way before querying:

```ts
import { normalize } from "zonemapdb";

const q = normalize("fold", userInput) ?? "";
await db.books.findMany({ where: { title_fold: { contains: q } } }); // "cafe" finds "Café Atlas"
```

`fold` lowercases and strips accents. The other normalizers are `lowercase`, `trim` and `numeric`, which parses numeric-looking strings into a number column so you get real number ranges. `normalize` in the runtime is the same function the build uses, so both sides always agree.

## Numbers and dates

Numbers and dates get equality, `in` and ranges, which prune on an indexed field. Combine `gt`/`gte` with `lt`/`lte` on one field for a between:

```ts
await db.books.findMany({ where: { pages: { gte: 300, lte: 400 } } });
await db.books.findMany({ where: { rating: { gt: 4.5 } } });
```

Dates are ISO 8601 strings (`"2005-01-18"` or a full timestamp) and compare as such:

```ts
await db.books.findMany({ where: { published: { gte: "2000-01-01", lt: "2010-01-01" } } });
```

## Booleans

`inStock` isn't indexed in this config, so a filter on it is a rider:

```ts
await db.books.findMany({ where: { language: { equals: "de" }, inStock: { equals: true } } });
```

## Missing values: null and absent

zonemapdb distinguishes a field that is `null` from one that is missing from the record ("absent"), and the config records which of the two each field can be. `init` detects both from the data:

- `"nullable": true`: some records hold `null`. The generated type is `T | null`, and the field gets `isNull` and `exists`.
- `"absent": true`: some records lack the key. The generated type is optional (`field?: T`), and the field gets `isAbsent` and `exists`.

`rating` is both, so its type is `rating?: number | null` and it gets all three operators. They're riders, so each needs a filter that prunes beside it:

```ts
const fr = { language: { equals: "fr" } } as const;
await db.books.findMany({ where: { ...fr, rating: { isNull: true } } });   // rating: null
await db.books.findMany({ where: { ...fr, rating: { isAbsent: true } } }); // no rating key
await db.books.findMany({ where: { ...fr, rating: { exists: true } } });   // has a real value
await db.books.findMany({ where: { ...fr, rating: { exists: false } } });  // null or absent
```

A missing value never matches a comparison: `rating: { gt: 4.5 }`, `rating: { equals: 5 }` and `rating: { not: 5 }` all skip records whose rating is null or absent.

The flags keep the generated types honest, so `build` enforces them: if your data gains a `null` or loses a key where the config doesn't allow it, the build fails and says which flag to add (or run `zonemapdb init --reinfer`). The operators are offered on every field except the sort field and list fields, whose missing values have their own rules; the flags shape the record type on every field.

## `not`

`not` excludes one value:

```ts
await db.books.findMany({
  where: { language: { equals: "fr" }, author: { not: "Erin Walsh" } },
});
```

`not` can't use an index (every file might hold a record that isn't Erin Walsh), so it's always a [rider](#riders-filters-that-dont-narrow-the-read): it only filters records that a pruning filter already selected.

## List fields

A field whose values are string arrays (`"multi": true`) takes list operators instead of scalar ones:

```ts
await db.books.findMany({ where: { tags: { some: "poetry" } } });                        // any tag is poetry
await db.books.findMany({ where: { tags: { some: { startsWith: "fi" } } } });            // any tag starts with fi
await db.books.findMany({ where: { tags: { hasEvery: ["poetry", "travel"] } } });        // has both
await db.books.findMany({ where: { tags: { every: { in: ["poetry", "travel"] } } } });   // no other tags
await db.books.findMany({ where: { tags: { isEmpty: true } } });                         // tags: []
```

- `some` takes an element filter using the field's own operators, or a bare value as shorthand for `{ equals: value }`.
- `every` passes an empty list, since an empty list has no element that fails. To require at least one element, add `some` with the same filter: `{ every: { in: ["poetry", "travel"] }, some: { in: ["poetry", "travel"] } }`.
- Operators on one field AND together, so an exact set is `hasEvery` plus `every`:

```ts
await db.books.findMany({
  where: { tags: { hasEvery: ["poetry", "travel"], every: { in: ["poetry", "travel"] } } },
}); // exactly poetry and travel
```

A record whose list is missing or `null` matches none of these, including `isEmpty`.

## No OR: what to do instead

`where` has no `OR`. For alternatives on one field, use `in` (or `some` on a list field). For alternatives across fields, run one query per branch and merge by primary key:

```ts
const [byAuthor, byTag] = await Promise.all([
  db.books.findMany({ where: { author: { equals: "Hana Sato" } } }),
  db.books.findMany({ where: { tags: { some: "poetry" } } }),
]);
const merged = new Map([...byAuthor.records, ...byTag.records].map((b) => [b.id, b]));
```

`OR` may be added later without breaking existing queries.

## Sorting

`orderBy` takes any field except a `json` one, `"asc"` or `"desc"`. It accepts list fields too, but compares them as joined strings, which is rarely a useful order. Several keys break ties in the order you write them:

```ts
await db.books.findMany({ orderBy: { title: "desc" }, limit: 10 });
await db.books.findMany({
  where: { author: { equals: "Hana Sato" } },
  orderBy: { published: "desc", pages: "asc" },
});
```

Without `orderBy`, results come in the order they're stored: ascending by the sort field, with records that have no sort value last.

**Sorting by the sort field is cheap; sorting by anything else reads every candidate.** Data is stored in sort-field order, so with a `limit`, a page ordered by the sort field alone is read from the first few files (the last few for `"desc"`) and the walk stops. Everything else reads every file the `where` selects before it can return a page: an `orderBy` on another field, one with several keys, no `limit`, or an `orderBy` on the sort field when some records have no sort value. So narrow the `where` before sorting large collections by another field.

With an explicit `orderBy`, missing values sort first in ascending order and last in descending order. On the sort field that differs from the stored order, where they come last, which is why that case has to read every candidate.

## Pagination

`limit` and `offset` page through results. `hasMore` says whether another page exists:

```ts
const page = await db.books.findMany({
  where: { language: { equals: "de" } },
  limit: 20,
  offset: 40, // the third page
});
page.hasMore; // true if there's a fourth page
page.total;   // the exact match count, when zonemapdb had to see every match anyway
```

`total` is present only when answering the query already meant reading every file the `where` selects. That's every case in [Sorting](#sorting) that reads every candidate, plus a walk in sort order that reached the last candidate before the page filled. The walk fetches files four at a time, so a query with few candidate files often gets `total` alongside `hasMore: true`. It's the true count, so prefer it over `count()` when it's there.

**The result ceiling.** A query never returns more than `maxResults` records (default 10,000). An explicit `limit` above it throws, and so does a query without `limit` that matches more records than that. Nothing is ever silently truncated. Paginate, or raise `maxResults` in `connect()` if you really need everything.

## Counting

`count` never fetches a data file. It answers from the manifest, plus any index chunks a filter on an indexed field needs, so it's fast but approximate:

```ts
const { count, exact } = await db.books.count({ language: { equals: "de" } });
```

- `count` is an **upper bound**: the number of records in every file that might match.
- `exact` is `true` only for an empty `where` (the total record count) and when nothing can match (`count: 0`), so `count === 0` is always a trustworthy "no results".
- For an exact number, use `total` from `findMany` when it's present, or run `findMany` without `limit` (capped by `maxResults`).

## Looking up by id

When the config names a `pk`, the collection has `get`:

```ts
const book = await db.books.get("b-00042"); // the record, or null
```

It's a compile error on a collection without a primary key.

## Cancelling a query

`findMany`, `count` and `get` take an optional `signal`, the standard `AbortSignal`. When it fires, the query's pending fetches are cancelled and the call rejects with `ZonemapDbError` code `ABORTED`. This suits search-as-you-type, where each keystroke supersedes the last query:

```ts
import { ZonemapDbError } from "zonemapdb";

let search: AbortController | undefined;

async function onInput(term: string) {
  search?.abort(); // the previous keystroke's query stops downloading
  search = new AbortController();
  try {
    const { records } = await db.books.findMany({
      where: { title: { startsWith: term } },
      limit: 10,
      signal: search.signal,
    });
    return records;
  } catch (e) {
    if (e instanceof ZonemapDbError && e.code === "ABORTED") return undefined; // superseded
    throw e;
  }
}
```

`count(where, { signal })` and `get(id, { signal })` work the same way. Cancelling one query never cancels the manifest download that other queries share: the cancelled query just stops waiting for it. A cancelled query also skips the stale-manifest retry described under [Errors](#errors).

A cancelled download is lost, so don't cancel by reflex. If the next query needs mostly the same files, which is typical when a prefix grows by one letter on the sort field, letting the old query finish fills the browser cache for the new one. Cancel when the old query's files are no longer the ones you need.

## Running queries in a Web Worker

A query parses every data file it downloads, and a block is often a few megabytes of NDJSON. On the main thread that parse can freeze the page for hundreds of milliseconds, which shows as a stutter when every keystroke runs a query. The runtime has no DOM dependency and works unchanged in a Web Worker, so move queries there when that matters:

```ts
// search.worker.ts
import { ZonemapDbError } from "zonemapdb";
import { connect } from "./zonemapdb/client";

const db = connect();

let search: AbortController | undefined;

self.onmessage = async (e: MessageEvent<{ term: string }>) => {
  search?.abort();
  search = new AbortController();
  try {
    const { records } = await db.books.findMany({
      where: { title: { startsWith: e.data.term } },
      limit: 10,
      signal: search.signal,
    });
    self.postMessage({ term: e.data.term, records });
  } catch (err) {
    if (err instanceof ZonemapDbError && err.code === "ABORTED") return;
    self.postMessage({ term: e.data.term, error: String(err) });
  }
};
```

The default `basePath` (`/zonemapdb`) starts with `/`, so it resolves the same in a worker as on the page. A path-relative `basePath` such as `"data/books"` resolves against the worker script's URL instead, and a worker made from a `blob:` URL has no usable base at all. In those cases pass an absolute URL: `connect({ basePath: new URL("data/books", location.origin).href })`.

On the page, create it with `new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" })`, `postMessage({ term })` on input, and render the results that come back. Records cross to the page as structured clones, which is cheap next to parsing. Each worker has its own client, so its manifest is downloaded once per worker, not shared with a client on the page.

## What a query costs

Every query first loads the manifest (once per client, revalidated with the host via `cache: "no-cache"`). The manifest records each file's value ranges, so the sort field and number/date ranges can rule out files without fetching anything else. On a large dataset those ranges for secondary fields may live in small sidecar files instead, fetched the first time a query needs them. Other operators may fetch small index chunks (about 45 KB each) to find which files contain a value. zonemapdb then fetches the remaining data files.

Roughly how many files a query fetches after the manifest, on a dataset split into a few dozen data files. The exact numbers depend on your data:

| Query | Files | Why |
|---|---|---|
| `title: { equals }` | 1 | The manifest's sort-field ranges point at the one file |
| `get` by id | 2 | One index chunk, then the file it names |
| `title: { startsWith }` or a title range | a few | A contiguous run of files, no index needed |
| Any query with a small `limit` and no `orderBy` | 4, then 8, … | The walk fetches four files at a time and stops once the page is full |
| `pages: { gte, lte }` on an indexed field | up to all | Only pruned where files' value ranges don't overlap |
| `tags: { every: … }`, `author: { endsWith }` | most | These admit many files |
| `orderBy` on a non-sort field | every candidate | Ordering needs all matches |

How to keep queries cheap:

- **Choose the sort field for your main access pattern.** Lookups, prefixes and ranges on it are the cheapest queries.
- **Always pass `limit`** unless you need every match.
- **Pair broad operators with a selective one.** `every`, the fragment operators and every rider get cheaper when another field narrows the candidates.
- **Don't index what can't prune.** A filter on an unindexed field still works as a rider. Heed the build's "barely prunes" warnings.
- **Inspect before deploying.** `zonemapdb inspect` reports sizes and warnings without rebuilding.

## Errors

The runtime throws one error class, `ZonemapDbError`, with a `code` to switch on:

```ts
import { ZonemapDbError } from "zonemapdb";

try {
  await db.books.findMany({ where: { language: { equals: "de" } } });
} catch (e) {
  if (e instanceof ZonemapDbError && e.code === "NETWORK") {
    // worth retrying
  }
}
```

| Code | Meaning | Retry? |
|---|---|---|
| `CONFIG` | No manifest at `basePath`: a 404, or an HTML page in its place (a single-page-app fallback). Check `basePath`. Also thrown for an unknown `scan` mode. | No |
| `FORMAT_VERSION` | The deployed data was built by an incompatible major version, or by a version too old for this runtime (before 0.3.0). Rebuild. | No |
| `DEPLOY_INTEGRITY` | A file the manifest names is missing (a 404, or an HTML fallback page), even after refetching the manifest. Usually a partial deploy, a client generated by a different build, or a stale cache (a CDN, a `fetch` wrapper, or an old page and bundled client) serving an earlier deploy. | No |
| `NETWORK` | `fetch` failed (an unreachable host, a blocked request) or returned a non-404 error status. | Maybe |
| `CORRUPT_DATA` | A file didn't parse, or didn't decompress (for example, brotli on a host that can't serve it; see the [deploy guide](deploy-guide.md)). | No |
| `LIMIT_EXCEEDED` | The query would return more than `maxResults`. | No, paginate |
| `NEEDS_PRUNING` | Every filter in the `where` is a [rider](#riders-filters-that-dont-narrow-the-read), so the query would read the whole dataset. Add a filter that prunes. Also thrown for a `scan: "block-order"` that can't stop early. | No |
| `ABORTED` | The query's `signal` fired (see [Cancelling a query](#cancelling-a-query)). Not a failure: usually a newer query superseded it. | No, ignore it |

Errors carry `e.url` (the file being fetched) where relevant, and `e.status` when there was an HTTP status (`NETWORK`, `CONFIG`, `DEPLOY_INTEGRITY`). They never include your `where`, so filter values don't end up in logs. There's no built-in retry for network errors: wrap `fetch` instead, as the [deploy guide](deploy-guide.md) shows. The one thing zonemapdb retries is a stale manifest: if a file the manifest names returns 404, it refetches the manifest with `cache: "reload"`, and if the new manifest no longer names that file, it reruns the query once against it. This covers a browser that kept the previous deploy's manifest after a redeploy.

## What the compiler catches

The generated types reject, at compile time:

- a field that isn't queryable: an unknown field, or a value operator on a `json` payload
- an operator the field's type doesn't have, such as a range on a string field other than the sort field
- a value outside a field's value union
- `isNull` on a field that isn't `nullable`, `isAbsent` on one that isn't `absent`, and `exists` on one that's neither
- a `where` made only of riders, such as only `not`, only `isNull`, or only filters on unindexed fields
- `get` on a collection without a primary key
- `isEmpty: false` (write nothing instead)
- `orderBy` on an unknown field or a `json` field
