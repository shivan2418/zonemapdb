# ADR-0014 — Naming: `zonedb`

## Status

Accepted. Supersedes the name `blockdb` from ADR-0011. The rest of ADR-0011 stands: Block is still the domain term for a data file and Chunk for a piece of the lazy index. ADR-0001 through ADR-0013 are left as written, so read "blockdb" there as "zonedb".

## Context

ADR-0011 chose `blockdb` without reserving it on npm (its point 8). At the first publish, after 0.6.0, npm refused the name as "too similar to existing package block.db". `blockdb-cli@0.6.0` had gone through by then, and was unpublished within npm's 72-hour window.

npm suggested a user scope (`@shivan2418/blockdb`). A scope can't collide with anyone else's name, but an unscoped name reads as a project rather than a person, so the project was renamed instead. npm's similarity check is opaque. Candidates were checked for being free with their hyphen, dot and underscore forms (the variants the check folds together), and still only prove out at publish time.

## Decision

1. **The name is `zonedb`.** It's named for the zone maps: the per-block `[min, max]` summaries that let a query skip data files, which is the heart of how it answers from a static host. It keeps ADR-0011's "db" and the tagline's correction of it.
2. **Rejected:** `chunkdb`, because Chunk already means an index piece and the name would suggest the data lives in chunks. `static-shard` and `shardkit`, because ADR-0011 retired "shard" as the wrong description. `blockql`, `blockrange` and `blockcdn` were free and would have kept "block", but `zonedb` was preferred.
3. **Derived names** follow the old ones one for one:
   - packages `zonedb` (runtime) and `zonedb-cli` (dev dependency), binary `zonedb`
   - `BlockDbError` → `ZoneDbError`, `BlockDbErrorCode` → `ZoneDbErrorCode`, `BlockDbConfig` → `ZoneDbConfig`
   - `zonedb.config.json`, output `public/zonedb/`, generated client `src/zonedb/`, messages prefixed `zonedb:`
4. **Domain terms don't change.** Block, Chunk, zonemap, missing tail, rider and the manifest's field names are untouched, so the served format is byte-for-byte what it was, apart from `generatorVersion`. `formatVersion` stays 0.
5. **The GitHub repo name is a separate step.** Links still point at `shivan2418/blockdb` until the repo moves; GitHub redirects the old URL when it does.

## Consequences

- The rename is breaking for every consumer, which today is `blockdb-demo-scryfall` and block-addresses. They swap the dependency, rename the config file and output folders, and update imports of `BlockDbError`. Built data keeps working: the runtime reads the manifest, not the package name.
- `blockdb-cli@0.6.0` existed on npm for a few hours. Anything that installed it should move to `zonedb-cli`.
- `context7.json`, `llms.txt` and the READMEs carry the new name. Search engines and caches may keep the old one for a while.
