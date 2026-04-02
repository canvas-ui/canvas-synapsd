# `scan.js` CLI

Ingest files into a SynapsD DB, or query that database. Run from the repo root (or adjust paths).

**Only the ingest commands take a filesystem directory** (`<path>` or `scan <path>`). **Find, search, get, and tree** only need the database via **`--db`** (default: **`<cwd>/.db`**).

```bash
node scripts/scan.js <path> [ingest-options]
node scripts/scan.js scan <path> [ingest-options]

node scripts/scan.js get <id> [options]
node scripts/scan.js find [options]
node scripts/scan.js search <query> [options]
node scripts/scan.js tree [tree-name] [options]
```

If you run `node scripts/scan.js <path> find ...` by mistake, the script errors and tells you to drop the path for query commands.

## Commands

| Command | Role | Example |
|--------|------|--------|
| *(path first)* | Ingest: scan directory `<path>` | `node scripts/scan.js ./my-project` |
| `scan` | Same; path is the next argument | `node scripts/scan.js scan ./my-project` |
| `get` | Load document by numeric id | `node scripts/scan.js get 42` |
| `find` | List documents | `node scripts/scan.js find --limit 50` |
| `search` | Full-text search; **query** is the next positional | `node scripts/scan.js search "invoice"` |
| `tree` | Dump a tree as JSON, or list trees | `node scripts/scan.js tree` or `tree filesystem` |

## Options

| Flag | Applies to | Meaning |
|------|------------|---------|
| `--exclude <glob>` | ingest | Extra glob to skip (repeatable). Built-in excludes cover `node_modules`, VCS dirs, binaries, etc. |
| `--db <dir>` | all | Database directory (default: `./.db`). |
| `--tree <name>` | `find`, `search`, `tree` | Tree name for queries / which tree to dump. |
| `--features f1,f2` | `find`, `search` | Comma-separated feature / schema filters. |
| `--limit <n>` | `find`, `search` | Max results. |
| `--no-lance` | ingest | Skip LanceDB indexing (faster writes; no vector search for those docs). |

## Examples

```bash
node scripts/scan.js ./my-project --exclude "*.pdf" --exclude "dist/**"
node scripts/scan.js find --features data/abstraction/file --limit 50
node scripts/scan.js search "invoice" --limit 20
node scripts/scan.js tree
node scripts/scan.js get 7
```

Ingest uses tree name **`filesystem`** and schema **`data/abstraction/file`**.
