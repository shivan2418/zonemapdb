# Ticket 1 — Monorepo scaffold: exact end state

> **Historical.** This is the plan for the first ticket, written when the project was called `static-shard`. The names, versions and `engines` values below are from then; it has since been renamed to blockdb, zonedb and now zonemapdb (ADR-0011, ADR-0014). See the root README and the package READMEs for the current state.

Goal: a two-package lockstep pnpm monorepo, both packages empty but green (`build`/`test`/`typecheck`/`pack:check`), ready for every later ticket. Stack: **pnpm workspaces · TypeScript `tsc` (ESM + `.d.ts`) · vitest · changesets (fixed/lockstep) · GitHub Actions CI**.

> Before finalizing versions/config, confirm the fiddly bits against context7: changesets `fixed` config, pnpm workspace file, and the `package.json` `exports` map. Install with latest (`pnpm add -D … -w`) rather than pinning guessed versions.

## Final tree

```
static-shard/
├─ package.json                    # private workspace root (identity below)
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .changeset/config.json
├─ .github/workflows/ci.yml
├─ scripts/check-pack.mjs          # pack hygiene assertion used by CI
├─ LICENSE                         # exists (MIT) — also referenced per-package
├─ README.md                       # exists — polished in the publish-gate ticket
├─ packages/
│  ├─ static-shard/                # the RUNTIME (inherits today's root identity)
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ LICENSE                   # copy of root MIT (npm publishes per-package)
│  │  ├─ README.md                 # short stub; real content in publish gate
│  │  └─ src/index.ts              # `export {}` placeholder
│  └─ static-shard-cli/            # the BUILD TOOL
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ config.schema.json        # `{}` placeholder; filled by the inference ticket
│     ├─ LICENSE
│     ├─ README.md
│     └─ src/
│        ├─ index.ts               # `export {}` placeholder
│        └─ bin.ts                 # `#!/usr/bin/env node` + minimal arg stub
└─ (prototypes/, examples/ stay put — NOT workspace members yet)
```

`packages/*` is the only workspace glob, so `prototypes/` and `examples/` (which have their own `node_modules`) are excluded.

## Root `package.json`

```json
{
  "name": "static-shard-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "pack:check": "node scripts/check-pack.mjs",
    "changeset": "changeset",
    "version": "changeset version",
    "release": "pnpm build && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "latest",
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

The current root identity (name `static-shard`, description, keywords, author, license) **moves into `packages/static-shard`** — the root becomes a private, unpublished workspace root.

## `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
```

## `packages/static-shard/package.json` (runtime — zero third-party runtime deps)

```json
{
  "name": "static-shard",
  "version": "0.0.0",
  "description": "Query large static datasets from any static host — sharded into many small files, typed client, no WASM, no HTTP Range.",
  "type": "module",
  "license": "MIT",
  "author": "Emil Elgaard",
  "keywords": ["static","database","sharding","query","large-data","browser","static-site","typescript","typed","codegen","cdn","no-backend"],
  "engines": { "node": ">=18" },
  "sideEffects": false,
  "files": ["dist"],
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "repository": { "type": "git", "url": "git+https://github.com/shivan2418/static-shard.git", "directory": "packages/static-shard" },
  "homepage": "https://github.com/shivan2418/static-shard#readme",
  "bugs": "https://github.com/shivan2418/static-shard/issues",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "pack:check": "npm pack --dry-run --json"
  }
}
```

No `dependencies` key at all (it must stay empty — CI asserts this). No `bin`.

## `packages/static-shard-cli/package.json` (build tool)

```json
{
  "name": "static-shard-cli",
  "version": "0.0.0",
  "description": "Build tool for static-shard: infer → shard → index → codegen + config wizard.",
  "type": "module",
  "license": "MIT",
  "author": "Emil Elgaard",
  "engines": { "node": ">=18" },
  "bin": { "static-shard": "./dist/bin.js" },
  "files": ["dist", "config.schema.json"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "repository": { "type": "git", "url": "git+https://github.com/shivan2418/static-shard.git", "directory": "packages/static-shard-cli" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "pack:check": "npm pack --dry-run --json"
  }
}
```

CLI deps are added as real deps in later tickets; they never reach the runtime package.

## `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`DOM` lib is for the runtime (`fetch`, `AbortController`, `DecompressionStream`). The CLI picks up Node globals from the root `@types/node` devDep.

## Per-package `tsconfig.json` (identical in both packages)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

## `.changeset/config.json` (lockstep = the compatibility contract)

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["static-shard", "static-shard-cli"]],
  "linked": [],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

`fixed` forces both packages to bump and release on **one shared version** — the single knob that encodes runtime/CLI compatibility.

## `scripts/check-pack.mjs` (CI hygiene gate)

Runs `npm pack --dry-run --json` in each package and asserts:
- runtime `static-shard` tarball contains only `dist/**` (+ `package.json`, `LICENSE`, `README.md` that npm always includes) — **no `src/`, no fixtures, no test data**;
- CLI tarball additionally contains `config.schema.json`;
- `packages/static-shard/package.json` has **no non-empty `dependencies`**.

Exit non-zero on any violation so CI fails loudly. (A ~40-line script reading the JSON file list — implement literally, no cleverness.)

## `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push: { branches: [master] }
  pull_request:
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
      - run: pnpm pack:check
```

## Placeholder sources

- `packages/static-shard/src/index.ts` → `export {}` (grown into `connect()` in the walking-skeleton ticket).
- `packages/static-shard-cli/src/index.ts` → `export {}`.
- `packages/static-shard-cli/src/bin.ts` → `#!/usr/bin/env node` shebang + a stub that prints usage / version (grown into `init`/`build`/`inspect` later).
- Add one trivial passing vitest per package (e.g. `expect(true).toBe(true)`) so `pnpm test` is green rather than erroring on "no tests".

## Done-when

- `pnpm install` → `pnpm typecheck && pnpm build && pnpm test && pnpm pack:check` all green from a clean checkout.
- `packages/static-shard` publishes ESM-only, `sideEffects:false`, no `bin`, empty runtime deps (verified by `pack:check`).
- `packages/static-shard-cli` exposes the `static-shard` bin and ships `config.schema.json`.
- A `changeset version` dry run bumps both packages together to the same version.
- pnpm only; `pnpm-lock.yaml` is the sole lock file.
