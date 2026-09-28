---
"zonemapdb": minor
"zonemapdb-cli": minor
---

**Breaking: renamed from `zonedb` to `zonemapdb`** (ADR-0014). npm refused `zonedb` as too similar to existing packages, so 0.7.0 was never on npm. The packages are now `zonemapdb` and `zonemapdb-cli`, and the command is `zonemapdb`. `ZoneDbError`, `ZoneDbErrorCode` and `ZoneDbConfig` become `ZonemapDbError`, `ZonemapDbErrorCode` and `ZonemapDbConfig`. The config file is now `zonemapdb.config.json`, and the default output folders are `public/zonemapdb/` and `src/zonemapdb/`. Built data is unchanged.
