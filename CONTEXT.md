# zonedb

Glossary for the project: a build tool that splits a large static dataset into many small whole files, indexes them, and generates a typed client that fetches only the files a query needs — no backend, no WASM, no HTTP Range.

## Language

**Block**:
One of the small whole files `build` emits: a size-bounded slice of the globally-sorted dataset, holding a non-overlapping value range of the sort field and carrying a per-field zonemap. The unit a query prunes down to.
_Avoid_: Shard (oversells hash/distribution routing that doesn't happen; the project's old name, retired in ADR-0011), Chunk (reserved for index pieces; undersells the pruning semantics).

**Missing tail**:
The run of records whose sort-field value is null or absent, clustered after every real value at the high end of the sorted dataset. Its own term so that "block" only ever means a data file.
_Avoid_: missing block.

**Zonemap**:
Per-block `[min, max]` for an indexed field. Non-overlapping for the sort field (exact pruning), overlapping for secondary fields (weak pruning). Always-downloaded in the manifest (may spill to sidecars). Heritage: Netezza/Redshift zone maps over blocks.

**Chunk**:
A piece of the lazy inverted index — distinct values sorted and cut into value-range-keyed chunks, fetched on demand. Distinct from a block: a chunk is index, a block is data.
_Avoid_: using "chunk" for data files.

**Range-partitioning**:
How `build` produces blocks: globally sort by one field, cut the sorted stream into size-bounded pieces with non-overlapping value ranges. Not hash-sharding (which would destroy the ranges), not plain size-chunking (which carries no pruning semantics).

**Sort field**:
The single field the dataset is globally sorted by. Its zonemap is non-overlapping, giving free exact range-pruning. Exactly one per dataset; a user choice surfaced in the wizard.

**Manifest**:
The root file every client downloads in full up-front: schema, block identity (ordinal → content-hash), sort-field split-points, and index chunk directories. Budgeted (~1 MB gzipped); anything that grows with the data spills to lazily-fetched sidecars.

**Pruning constraint**:
A filter that narrows which blocks a query reads: one on the sort field, or one backed by an index structure. Every `where` needs at least one, so no query reads the whole dataset.

**Rider**:
A filter that narrows nothing and only tests records already fetched: `not`, the missing-value operators, and any filter on an unindexed field. Valid only alongside a pruning constraint.
_Avoid_: post-filter, residual filter, filter-only.

**Indexed field**:
A field with index structures behind some of its filters, so those filters prune. Being indexed is a cost-for-speed choice, not what makes a field queryable.

**Unindexed field**:
A queryable field with no index structure: every filter on it is a rider.
