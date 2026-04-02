# `scan.js` CLI

Ingest files into a SynapsD DB, or query that database.

The **command** is always the first positional argument. All flags are named and **position-independent** — they can appear before or after the command in any order.

## Commands

| Command  | What it does                              |
|----------|-------------------------------------------|
| `scan`   | Walk a directory and ingest files         |
| `get`    | Retrieve a document by numeric ID         |
| `find`   | List/filter documents                     |
| `search` | Full-text search                          |
| `tree`   | Dump a tree as JSON, or list all trees    |

## Flags

| Flag                 | Applies to          | Meaning                                                               |
|----------------------|---------------------|-----------------------------------------------------------------------|
| `--path <dir>`       | `scan`              | Directory to ingest *(required)*                                      |
| `--id <n>`           | `get`               | Numeric document ID *(required)*                                      |
| `--query <text>`     | `search`            | Search query *(required)*                                             |
| `--name <name>`      | `tree`              | Tree to dump; omit to list all trees                                  |
| `--db <dir>`         | all                 | Database directory (default: `./.db`)                                 |
| `--tree <name>`      | `find`, `search`    | Filter by tree name                                                   |
| `--features <f1,f2>` | `find`, `search`    | Comma-separated feature / schema filters                              |
| `--limit <n>`        | `find`, `search`    | Max results                                                           |
| `--exclude <glob>`   | `scan`              | Extra glob to skip (repeatable). Built-in excludes cover `node_modules`, VCS dirs, binaries, etc. |
| `--no-lance`         | `scan`              | Skip LanceDB indexing (faster writes; no vector search for those docs) |

## Examples

```bash
# Ingest
node scripts/scan.js scan --path ./my-project
node scripts/scan.js scan --path ./my-project --exclude "*.pdf" --exclude "dist/**"
node scripts/scan.js scan --path ./my-project --no-lance --db /tmp/mydb

# Query
node scripts/scan.js find --features data/abstraction/file --limit 50
node scripts/scan.js search --query "invoice" --limit 20
node scripts/scan.js search --query "invoice" --db /tmp/mydb --tree filesystem
node scripts/scan.js tree
node scripts/scan.js tree --name filesystem
node scripts/scan.js get --id 7

# Flags before the command work too
node scripts/scan.js --db /tmp/mydb search --query "report"
```
