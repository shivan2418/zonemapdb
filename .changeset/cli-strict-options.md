---
"zonemapdb-cli": patch
---

An option a command doesn't know is now an error instead of being ignored. `zonemapdb build --out dist` used to build to the config's `output` without a word; it now fails and points at `zonemapdb build --help`. A bare `zonemapdb inspect` reads `zonemapdb.config.json`, as its help always said, instead of failing. `config.schema.json` no longer requires `indexed: true` beside `absent: true`, so editors stop flagging configs that `init` writes for unindexed fields.
