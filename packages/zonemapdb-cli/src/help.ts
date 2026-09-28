/**
 * `--help` text, kept as data in its own side-effect-free module so it can be unit-tested against
 * the flags `bin.ts` actually parses (help text that drifts from the real flag set is worse than
 * none). Every flag named here must exist; every flag `bin.ts` handles must be named here.
 */

export const TOP_LEVEL_HELP = `zonemapdb <command> [options]

  Query a large dataset from any static host: no backend,
  no WASM, no HTTP Range requests.

Commands
  init [input]              Infer a schema and write zonemapdb.config.json
  build                     Block + index the data, regenerate the typed client
  inspect                   Report sizes, costs and warnings without rebuilding

Options
  --config <path>           Config file (default: zonemapdb.config.json)
  -h, --help                Show this help
  -v, --version             Show the installed version

Run \`zonemapdb <command> --help\` for a command's own options.

Typical first run:
  zonemapdb init data/movies.ndjson     # guided wizard, writes the config
  zonemapdb build                       # → public/zonemapdb/ + src/zonemapdb/`;

const INIT_HELP = `zonemapdb init [input] [options]

  Infers a schema from your data and writes zonemapdb.config.json. In a real
  terminal this opens the guided wizard; pass --yes to take the inferred
  defaults with no prompts (required in CI). This is the only command that
  infers — \`build\` replays what the config says.

Input
  [input]                   Path or glob to the data file(s) — required on first run
  --format <fmt>            ndjson (default) | json | csv | tsv
  --delimiter <char>        Column delimiter for csv/tsv (default: , or tab)
  --records <path>          json only: dot-path to the array/map of records
  --collection <name>       Name the generated collection (default: input filename)

Schema
  --sort-field <field>      Field to sort and range-partition by (number, date or string)
  --pk <field>              Field to use as the primary key, unlocking get(id)
  --indexed <a,b,c>         The complete set of indexed fields, whose filters prune
                            (replaces, not merges; every field is filterable anyway)
  --ends-with <a,b>         Also support endsWith on these (builds a reversed index)
  --contains <a,b>          Also support contains on these (builds a trigram index)

Inference
  --full-scan               Infer from every record (the default; explicit form)
  --sample                  Infer from a leading sample instead of the whole input
  --sample-size <n>         Infer from the leading <n> records instead of the whole input
  --reinfer                 Refresh what the config learned from the data (see below)

Output
  --output <dir>            Served data tree (default: public/zonemapdb)
  --client-out <dir>        Generated client directory (default: src/zonemapdb)
  --base-path <url>         Baked default for connect() (default: derived from --output)
  --block-bytes <n>         Target bytes per data file (default: 2 MiB)
  --index-chunk-bytes <n>   Target bytes per index chunk (default: ~45 KB)

Other
  --yes                     No prompts — accept the inferred defaults
  --config <path>           Where to write the config (default: zonemapdb.config.json)
  -h, --help                Show this help

With an existing config, --reinfer re-reads the data and refreshes only what init
learned from it: field kinds, absent/nullable, list fields, value sets, and fields
added to or removed from the data. It keeps your choices: the sort field, the pk,
which fields are indexed, endsWith/contains, compression, block sizes, derived
fields and tsType. New fields get the same defaults a first run would give them.
Flags still override everything.

Fields holding nested or mixed-type values become payload-only: still stored and
returned by findMany, but not filterable. Naming one in --indexed/--ends-with/
--contains drops that flag with a warning rather than failing the run.

An indexed string field with few enough distinct values is treated as enum-like:
its values are baked into the config, codegen exports them as a named union, and
equals/in/not/some/hasEvery narrow to it. Delete the field's "values" array in the config to
widen it back to plain string.`;

const BUILD_HELP = `zonemapdb build [options]

  Reads the committed config, blocks and indexes the data, writes the served
  tree, and regenerates the typed client — in one pass. Headless and safe in
  CI: it never re-infers, and fails loudly if the data has drifted from the
  schema baked into the config.

Options
  --config <path>           Config file (default: zonemapdb.config.json)
  -h, --help                Show this help

Writes two things: the data tree at the config's \`output\` (deploy this) and
\`schema.ts\`/\`client.ts\` at its \`clientOut\` (commit these).`;

const INSPECT_HELP = `zonemapdb inspect [options]

  Read-only report — block count and size spread, manifest size against its
  budget, per-field index sizes, representative query costs, and any warnings.
  Never writes anything.

Options
  --config <path>           Report from a config, materializing the tree in
                            memory without writing it (default: zonemapdb.config.json)
  --dir <path>              Report from an already-built output directory instead
  --json                    Emit the report as JSON
  -h, --help                Show this help`;

export const COMMAND_HELP: Record<string, string> = {
  init: INIT_HELP,
  build: BUILD_HELP,
  inspect: INSPECT_HELP,
};

/** Global flags recognized before any command, so they aren't per-command `case` entries in `bin.ts`. */
export const GLOBAL_FLAGS = ["--help", "-h", "--version", "-v"] as const;

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h";
}

export function isVersionFlag(arg: string | undefined): boolean {
  return arg === "--version" || arg === "-v";
}
