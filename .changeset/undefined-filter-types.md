---
"zonemapdb": patch
---

A filter set to `undefined` now type-checks, as the query guide always said it did: `{ set: chosen ? { equals: chosen } : undefined }` compiles in `findMany` and `count`. The runtime already dropped these filters; only the generated types rejected them. A `where` whose filters are all `undefined` is the empty `where`, and an `undefined` filter never counts as the one that prunes.
