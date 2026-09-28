# ADR-0014 — Naming: `zonemapdb`

## Status

Accepted. Supersedes the name `blockdb` from ADR-0011. The rest of ADR-0011 stands: Block is still the domain term for a data file and Chunk for a piece of the lazy index. ADR-0001 through ADR-0013 are left as written, so read "blockdb" there as "zonemapdb".

## Context

ADR-0011 chose `blockdb` without reserving it on npm (its point 8). At the first publish, after 0.6.0, npm refused it as "too similar to existing package block.db". `blockdb-cli@0.6.0` had gone through by then, and was unpublished within npm's 72-hour window.

The first replacement, `zonedb` (released on GitHub only, as 0.7.0), was refused as "too similar to existing packages nedb, zona-b". It had been checked only for being free with its hyphen, dot and underscore forms. npm evidently also blocks names a couple of edits away from existing packages.

npm suggested a user scope each time (`@shivan2418/...`). A scope can't collide with anything, but an unscoped name reads as a project rather than a person.

## Decision

1. **The name is `zonemapdb`.** It's named for the zone maps: the per-block `[min, max]` summaries that let a query skip data files, which is the heart of how it answers from a static host. It keeps ADR-0011's "db" and the tagline's correction of it.
2. **How a name is vetted.** Test it against the full npm name list (`all-the-package-names`, 4.5M names). Strip punctuation from every name, then require no existing package within Levenshtein distance 2. That rule is stricter than npm's: it flags both rejected names, but it would also have flagged `blockdb-cli`, which npm accepted. `zonemapdb` and `zonemapdb-cli` have no neighbour within distance 2. Its nearest names at distance 3 are `zonamap` and `tonemap`.
3. **Rejected:** `chunkdb`, because Chunk already means an index piece. `static-shard` and `shardkit`, because ADR-0011 retired "shard" as the wrong description. `zonedb`, which npm refused.
4. **Derived names** follow the old ones one for one:
   - packages `zonemapdb` (runtime) and `zonemapdb-cli` (dev dependency), binary `zonemapdb`
   - `BlockDbError` → `ZonemapDbError`, `BlockDbErrorCode` → `ZonemapDbErrorCode`, `BlockDbConfig` → `ZonemapDbConfig` ("zonemap" is one word, as in the domain term)
   - `zonemapdb.config.json`, output `public/zonemapdb/`, generated client `src/zonemapdb/`, messages prefixed `zonemapdb:`
5. **Domain terms don't change.** Block, Chunk, zonemap, missing tail, rider and the manifest's field names are untouched, so the served format is byte-for-byte what it was, apart from `generatorVersion`. `formatVersion` stays 0.
6. **The GitHub repo moved** from `shivan2418/blockdb` to `shivan2418/zonemapdb`. GitHub redirects the old URL, including the release tarball links the demos installed from.

## Consequences

- The rename is breaking for every consumer, which today is `blockdb-demo-scryfall` and block-addresses. They swap the dependency, rename the config file and output folders, and update imports of `BlockDbError`. Built data keeps working: the runtime reads the manifest, not the package name.
- `blockdb-cli@0.6.0` existed on npm for a few hours, and `zonedb` never did. Anything that installed `blockdb-cli` should move to `zonemapdb-cli`.
- `context7.json`, `llms.txt` and the READMEs carry the new name.
