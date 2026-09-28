---
"zonedb": minor
"zonedb-cli": minor
---

**Breaking: renamed from `blockdb` to `zonedb`** (ADR-0014), because npm refused `blockdb` as too similar to an existing package. The packages are now `zonedb` and `zonedb-cli`, and the command is `zonedb`. `BlockDbError`, `BlockDbErrorCode` and `BlockDbConfig` become `ZoneDbError`, `ZoneDbErrorCode` and `ZoneDbConfig`, and messages start with `zonedb:`. The config file is now `zonedb.config.json`, and the default output folders are `public/zonedb/` and `src/zonedb/`. Built data is unchanged (`formatVersion` 0), so existing deploys keep working. To migrate: swap the dependencies, rename the config file, run `zonedb build`, and update any `BlockDbError` imports.
