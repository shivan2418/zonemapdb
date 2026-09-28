# zonemapdb

Query large datasets from any static host: no backend, no WASM, no HTTP Range requests.

`zonemapdb` splits a large dataset into many small files at build time, builds indexes over them, and generates a **typed client** that fetches only the files a query needs. Because it fetches whole small files (not byte ranges of one big file), it works on any dumb static host and every block is a plain, compressible, cacheable CDN object.

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
const { records } = await db.movies.findMany({
  where: { year: { gte: 2000 }, rating: { gt: 8 } },
  orderBy: { rating: "desc" },
  limit: 20,
});
```

Every operator, sorting, pagination, counting and what each query costs: see the **[query guide](docs/query-guide.md)**.

Two complete, working example apps — a movie catalog and a product lookup, each building → deploying → querying in a real browser — live in [`examples/`](https://github.com/shivan2418/zonemapdb/tree/master/examples).

Two live demos run on GitHub Pages with real datasets:

- **[Card search](https://shivan2418.github.io/blockdb-demo-scryfall/)** ([source](https://github.com/shivan2418/blockdb-demo-scryfall)): about 116,000 Magic: The Gathering cards, with name search, filters and sorting.
- **[Address lookup](https://shivan2418.github.io/zonemapdb-demo-addresses/)** ([source](https://github.com/shivan2418/zonemapdb-demo-addresses)): about 160 million US addresses in 817 MB of compressed files. Looking up one address transfers about 0.17 MB.

## Why zonemapdb?

The problem — *query a big dataset in the browser, with no database server and no backend, served from plain static hosting* — is well-trodden. Almost every existing tool solves it the **opposite way** from zonemapdb: keep **one big file** and read byte-slices of it with **HTTP Range requests** inside a **WebAssembly engine**.

zonemapdb splits your data into **many small whole files** at build time, indexes them, and generates a **typed client** that fetches only the files a query needs. That trade buys three things the one-big-file approach can't easily get:

- **Doesn't depend on HTTP Range.** Most major hosts do answer Range requests — GitHub Pages, S3/CloudFront and Cloudflare all return `206 Partial Content` — so the point isn't that Range is unavailable. It's that Range is fragile: a CDN that falls back to a full `200`, a proxy that drops the header, or a host that compresses the response turns a one-page read into a whole-file download or a broken query. zonemapdb fetches whole files by URL, so anything that can serve a file works.
- **Compression actually works.** When a host compresses on the fly, a byte range applies to the *compressed* bytes (GitHub Pages does this), and Cloudflare ignores `Range` entirely when it has to decompress a response. So range-reading tools must serve their data file uncompressed and keep the host from compressing it; sql.js-httpvfs [broke on GitHub Pages in 2025](https://github.com/orgs/community/discussions/162857) for exactly this reason. Whole-file blocks compress end-to-end, by the host or at build time — a big deal for JSON, which shrinks 5–10×.
- **A typed client, no engine.** The generated client is small JS with no multi-MB WASM to download and compile before the first query. Your fields and per-field operators are typed from the data.
- **Zero dependencies.** Neither package has a single runtime dependency: the runtime and the CLI are each one package that installs nothing else. Nothing to audit, no transitive update to break your build, and the runtime ships nothing to the browser beyond its own code.

**The honest cost:** many small files means **more HTTP requests** than a single range-read file, and it's **read-only** (you rebuild and redeploy to update). If those are dealbreakers, pick one of the alternatives below.

### Use zonemapdb when

- You have a **large, mostly-static, structured dataset** (roughly tens of MB up to ~1 GB) that you want to **query by field** (equality, ranges, `in`, simple string matches).
- The data is **read-only** from the browser's side — rebuild-to-update is fine.
- You have **no backend** — just static hosting or a CDN.
- You want **type-safe queries** in TypeScript, generated from your data.
- You want to keep the client **lightweight** (no WASM engine, no dependencies).

### Reach for something else when

**If you have — or can run — a server and an API, that is almost always the right choice.** A real backend with a database handles anything that mutates, needs authentication or private/per-user data, must always be fresh, or runs heavy relational/analytical queries. zonemapdb exists for when you *can't* or *won't* run one; don't adopt it to dodge building an API you actually need.

For the no-backend / static-hosting case specifically, here's the landscape and when each fits better:

| Tool | How it works | Reach for it instead when |
|------|--------------|---------------------------|
| **A backend + DB + API** (Postgres/Mongo + REST/GraphQL) | A server runs queries against a database | The data mutates, needs auth or private data, must be always-fresh, or needs joins / aggregations / full SQL. |
| **Just load the whole file** | `fetch()` the entire JSON and filter in memory | The dataset is small (a few MB or less) — below that, partitioning is pure overhead. |
| **sql.js-httpvfs** (phiresky) | SQLite → WASM, reads pages of one file via HTTP Range | You need full read-only **SQL** (joins, aggregates, OR, exact counts), your host answers Range requests without compressing the DB file, and WASM + an uncompressed DB file is acceptable. |
| **DuckDB-WASM + Parquet** | WASM SQL engine, range-reads Parquet row groups, prunes via column stats | You run heavy **analytical / aggregation** queries over columnar data and can afford a multi-MB WASM engine. |
| **hyparquet** | Pure-JS (no WASM) Parquet reader, range-fetches column chunks | You want to read **existing Parquet** files in the browser without WASM. |
| **PMTiles** | Single-file archive with an internal directory → any record in ≤2 range reads | Your data is **map tiles** or a key→blob archive served from one file. |
| **Pagefind / lunr / FlexSearch** | Build-time index shipped (or partitioned) to the browser | The query is **full-text search** over documents, not structured field filtering. |

zonemapdb overlaps most with **sql.js-httpvfs** (same goal — a database on static hosting) and **Pagefind** (same architecture — a build-time-partitioned index fetched on demand). It differs by targeting **structured + numeric-range queries** with **no WASM**, **no HTTP Range**, and a **typed generated client**.

## License

MIT
