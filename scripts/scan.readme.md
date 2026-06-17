# `scan.js` CLI

Ingest files into a SynapsD DB, or query that database.

```
scan [options] <command> [arguments]
```

Run `scan --help` for an overview, or `scan <command> --help` for command-specific options.

## Global options

| Flag | Meaning |
|------|---------|
| `-d, --db <dir>` | Database directory (default: `./.db`) |
| `-h, --help` | Show help |
| `-V, --version` | Show version |

Global flags can appear before or after the subcommand.

## Commands

| Command | What it does |
|---------|--------------|
| `scan` | Walk a directory and ingest files |
| `get` | Retrieve a document by numeric ID |
| `find` | List/filter documents |
| `search` | Full-text search |
| `tree` | Dump a tree as JSON, or list all trees |

## Command options

### `scan [path]`

| Flag | Meaning |
|------|---------|
| `[path]` | Directory to ingest *(required positional, or use `-p`)* |
| `-p, --path <dir>` | Same as positional path |
| `-t, --tree <name>` | Tree name (default: `filesystem`) |
| `-e, --exclude <glob>` | Extra glob to skip (repeatable). Built-in excludes cover `node_modules`, VCS dirs, binaries, etc. |
| `--no-lance` | Skip LanceDB indexing (faster writes; no vector search for those docs) |

### `get <id>`

| Flag | Meaning |
|------|---------|
| `<id>` | Numeric document ID *(required positional)* |

### `find`

| Flag | Meaning |
|------|---------|
| `-t, --tree <name>` | Filter by tree name |
| `--path <tree-path>` | Filter by tree path |
| `-f, --features <f1,f2>` | Comma-separated schema filters |
| `-l, --limit <n>` | Max results |

### `search [query...]`

| Flag | Meaning |
|------|---------|
| `[query...]` | Search text *(required positional, or use `-q`)* |
| `-q, --query <text>` | Same as positional query |
| `-t, --tree <name>` | Filter by tree name |
| `--path <tree-path>` | Filter by tree path |
| `-f, --features <f1,f2>` | Comma-separated schema filters |
| `-l, --limit <n>` | Max results |

### `tree [name]`

| Flag | Meaning |
|------|---------|
| `[name]` | Tree to dump; omit to list all trees |
| `-n, --name <name>` | Same as positional name |

## Examples

```bash
# Ingest
node scripts/scan.js scan ./my-project
node scripts/scan.js scan -p ./my-project -e "*.pdf" -e "dist/**"
node scripts/scan.js scan ./my-project --no-lance -d /tmp/mydb

# Query
node scripts/scan.js find -f data/abstraction/file -l 50
node scripts/scan.js search invoice -l 20
node scripts/scan.js search -q invoice -d /tmp/mydb -t filesystem
node scripts/scan.js tree
node scripts/scan.js tree filesystem
node scripts/scan.js get 7

# Help
node scripts/scan.js --help
node scripts/scan.js scan --help

# Global flags after the command work too
node scripts/scan.js search invoice -d /tmp/mydb
```
