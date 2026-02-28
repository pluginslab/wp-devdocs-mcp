# wp-devdocs-mcp

<p align="center">
  <img src="assets/banner.jpg" alt="Before: AI guessing hook names. After: Verified database, no more hallucinations." width="600">
</p>

**Give your AI coding assistant a verified WordPress hook database instead of letting it guess.**

wp-devdocs-mcp is a local [MCP server](https://modelcontextprotocol.io/) that indexes every action, filter, block registration, and JS API call from WordPress, WooCommerce, Gutenberg, or any plugin you work with. It gives AI tools like Claude Code a verified database to search and validate against instead of relying on training data.

Works with Claude Code, Cursor, Windsurf, and any MCP-compatible client.

## Why This Exists

AI coding assistants are changing how we build WordPress plugins. Tools like Claude Code, Cursor, and Windsurf can scaffold entire plugins in minutes — but they all share the same blind spot: **hook names come from training data, not from the actual source code**.

Most of the time this works fine. Models like Claude Sonnet nail common hooks almost every time. But "most of the time" isn't good enough when you're shipping production code, and not every model is Claude Sonnet. Across the landscape of LLMs doing code generation today:

- **Some models invent hooks that don't exist** — `woocommerce_email_after_order_details` sounds right but isn't real
- **Some use deprecated namespaces** — `wp.editor.InspectorControls` instead of `wp.blockEditor.InspectorControls`
- **Most miss newer hooks** — suggesting `pre_get_posts` for WooCommerce order queries when HPOS uses `woocommerce_order_list_table_prepare_items_query_args`
- **Parameters get mixed up** — wrong argument count or order in callback signatures
- **No model knows your custom plugins** — private or proprietary hooks are invisible to every model's training data

The core issue is simple: we can't rely 100% on any model to produce correct WordPress hook names from memory alone. Even the best models benefit from verification, and the rest genuinely need it. You only find out about hallucinated hooks when the code doesn't work — and in an agentic workflow where the AI writes, tests, and iterates autonomously, one bad hook name can send it down a rabbit hole of debugging something that was never going to work.

## The Solution

**Feed the LLM real data.** Instead of hoping the model remembers the right hook name, give it a verified database to query.

wp-devdocs-mcp parses the actual source code of any WordPress plugin and builds a searchable index of every hook with its exact name, type, parameters, file location, and surrounding code context. Your AI assistant queries this index before writing code — so every hook name in the generated code is verified against the real source.

This fits naturally into agentic coding workflows. When Claude Code (or any MCP-compatible assistant) needs to use a WordPress hook, it:

1. **Searches** the indexed database for relevant hooks
2. **Validates** the exact hook name exists before writing it into code
3. **Reads the context** — parameters, docblock, surrounding code — to use it correctly

No hallucination. No guessing. No debugging phantom hooks.

**What gets indexed:**

| Type | Examples |
|------|---------|
| PHP actions | `do_action()`, `do_action_ref_array()` |
| PHP filters | `apply_filters()`, `apply_filters_ref_array()` |
| JS hooks | `addAction()`, `addFilter()`, `applyFilters()`, `doAction()` |
| Block registrations | `registerBlockType()`, `registerBlockVariation()` |
| JS API usages | `wp.blocks.*`, `wp.blockEditor.*`, `wp.data.*`, etc. |
| Markdown documentation | Handbooks parsed into searchable pages *(since v1.1.0)* |

**What the AI gets for each hook:**

- Exact name (with dynamic name detection for hooks like `woocommerce_thankyou_{$payment_method}`)
- Type (action / filter / js_action / js_filter)
- Parameters and count
- File path and line number
- Enclosing function and class
- Docblock
- Code window (8 lines before, 4 after)
- Source plugin name

## Quick Start

```bash
# Clone and install
git clone https://github.com/pluginslab/wp-devdocs-mcp.git
cd wp-devdocs-mcp
npm install

# Add all preset sources at once (since v1.1.0)
npx wp-hooks quick-add-all

# Or add individual presets (since v1.1.0)
npx wp-hooks quick-add wp-core
npx wp-hooks quick-add woocommerce
npx wp-hooks quick-add gutenberg-source
npx wp-hooks quick-add plugin-handbook
```

Or add sources manually (works in all versions):

```bash
# WooCommerce (uses trunk branch)
npx wp-hooks source:add \
  --name woocommerce \
  --type github-public \
  --repo https://github.com/woocommerce/woocommerce \
  --subfolder plugins/woocommerce \
  --branch trunk
```

That's it. 3,500+ hooks indexed in under a minute.

### Connect to Your AI Assistant

Add the MCP server to your configuration. Create or edit `.mcp.json` in your project root (or `~/.claude/.mcp.json` globally):

```json
{
  "mcpServers": {
    "wp-devdocs": {
      "command": "npx",
      "args": ["--prefix", "/absolute/path/to/wp-devdocs-mcp", "wp-devdocs-mcp"]
    }
  }
}
```

Now when you ask Claude Code to write WordPress plugin code, it will automatically search and validate hook names against your indexed sources before generating code.

The server auto-updates stale sources (>24h) in the background on each start. Disable with `WP_MCP_AUTO_UPDATE=false`. *(since v1.1.0)*

## Available Presets *(since v1.1.0)*

Pre-configured sources you can add with a single command:

| Preset | What It Indexes |
|--------|----------------|
| `wp-core` | WordPress core hooks (wordpress-develop, trunk) |
| `gutenberg-source` | Gutenberg plugin source code |
| `gutenberg-docs` | Gutenberg/block editor documentation |
| `woocommerce` | WooCommerce plugin hooks (plugins/woocommerce) |
| `plugin-handbook` | Plugin developer handbook |
| `rest-api-handbook` | REST API documentation |
| `wp-cli-handbook` | WP-CLI reference |
| `admin-handbook` | Advanced administration handbook |

## Indexing Sources

### WordPress Core

```bash
npx wp-hooks source:add \
  --name wordpress \
  --type github-public \
  --repo https://github.com/WordPress/wordpress-develop \
  --branch trunk
```

Expected output:

```
Source "wordpress" added successfully.

Indexing "wordpress"...
Fetching source: wordpress (github-public)...
Indexing source: wordpress from ~/.wp-devdocs-mcp/cache/WordPress--wordpress-develop
Found 2025 files to check in wordpress

Indexing complete:
  Files processed:   2025
  Files skipped:     0
  Hooks inserted:    3459
  Hooks updated:     0
  Hooks unchanged:   0
  Blocks indexed:    0
  APIs indexed:      140
```

### Gutenberg

```bash
npx wp-hooks source:add \
  --name gutenberg \
  --type github-public \
  --repo https://github.com/WordPress/gutenberg \
  --branch trunk
```

### WooCommerce

```bash
npx wp-hooks source:add \
  --name woocommerce \
  --type github-public \
  --repo https://github.com/woocommerce/woocommerce \
  --subfolder plugins/woocommerce \
  --branch trunk
```

### Any Public Plugin

```bash
# Example: Advanced Custom Fields
npx wp-hooks source:add \
  --name acf \
  --type github-public \
  --repo https://github.com/AdvancedCustomFields/acf

# Example: WPGraphQL
npx wp-hooks source:add \
  --name wpgraphql \
  --type github-public \
  --repo https://github.com/wp-graphql/wp-graphql
```

### Your Private Plugins

For private GitHub repos, store your token in an environment variable (never in the config):

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx

npx wp-hooks source:add \
  --name my-private-plugin \
  --type github-private \
  --repo https://github.com/yourorg/your-plugin \
  --token-env GITHUB_TOKEN
```

### Local Plugin Development

Point directly at a folder on your machine — great for plugins you're actively developing:

```bash
npx wp-hooks source:add \
  --name my-local-plugin \
  --type local-folder \
  --path /path/to/wp-content/plugins/my-plugin
```

### Documentation Sources *(since v1.1.0)*

Index markdown handbooks and documentation alongside source code:

```bash
npx wp-hooks source:add \
  --name my-docs \
  --type github-public \
  --repo https://github.com/org/docs-repo \
  --content-type docs
```

### Source Options

| Option | Description |
|--------|-------------|
| `--name` | Unique name for this source (required) |
| `--type` | `github-public`, `github-private`, or `local-folder` (required) |
| `--repo` | GitHub repository URL |
| `--subfolder` | Only index a subfolder within the repo |
| `--branch` | Git branch (default: `main` — use `trunk` for WordPress/WooCommerce repos) |
| `--token-env` | Environment variable name holding a GitHub token (private repos) |
| `--path` | Local folder path |
| `--content-type` | `source` (default) or `docs` *(since v1.1.0)* |
| `--no-index` | Register the source without indexing it yet |

## What Gets Indexed

**Source code** (`--content-type source`, default):
- PHP hooks: `do_action()`, `apply_filters()`, `*_ref_array()` variants
- JS hooks: `addAction()`, `addFilter()`, `applyFilters()`, `doAction()`
- Block registrations: `registerBlockType()`, `registerBlockVariation()`
- JS API usages: `wp.blocks.*`, `wp.blockEditor.*`, `wp.data.*`, etc.

**Documentation** (`--content-type docs`) *(since v1.1.0)*:
- Markdown handbooks parsed into searchable pages with metadata, code examples, and categorization
- Specialized parsers for block editor docs, plugin handbook, REST API reference, WP-CLI handbook, and admin handbook

Each hook record includes: exact name, type, parameters, file path, line number, enclosing function/class, docblock, surrounding code context, and dynamic name detection.

## MCP Tools

Seven tools are exposed to your AI assistant (four original + three added in v1.1.0):

### `search_hooks`

Full-text search with BM25 ranking across all indexed hooks. Supports filters for type, source, dynamic hooks, and removed hooks.

### `validate_hook`

Exact-match check — returns `VALID` with file locations, `NOT_FOUND` with similar suggestions, or `REMOVED` for deprecated hooks. This is how the AI confirms a hook name before using it in code.

### `get_hook_context`

Returns the full code window around a hook: the line itself, 8 lines before, 4 lines after, the docblock, enclosing function, and class. Gives the AI enough context to use the hook correctly.

### `search_block_apis`

Searches block registrations (`registerBlockType`, etc.) and JavaScript API usages (`wp.blockEditor.*`, `wp.data.*`, etc.). Only matches on structured fields (block name, API call, namespace) — not surrounding code — to prevent false positives.

### `search_docs` *(since v1.1.0)*

Full-text search across indexed WordPress documentation. Supports filters for document type (guide, tutorial, reference, API, howto, FAQ), category, and source.

### `get_doc` *(since v1.1.0)*

Retrieve the full content of a specific documentation page by its ID. Returns the page title, content, metadata, code examples, and related links.

### `list_docs` *(since v1.1.0)*

Browse available documentation with optional filters for type, category, and source. Useful for discovering what documentation is indexed.

## CLI Reference

```
Source management:
  wp-hooks source:add         Add a source and index it
  wp-hooks source:list        List all sources with indexed status
  wp-hooks source:remove      Remove a source and all its data

Presets (since v1.1.0):
  wp-hooks quick-add <name>   Add a preset source
  wp-hooks quick-add-all      Add all preset sources

Indexing:
  wp-hooks index              Re-index all sources (or --source <name>, --force)
  wp-hooks update             Fetch and re-index stale sources (--source, --force) (since v1.1.0)

Search:
  wp-hooks search <query>     Search hooks (--type, --source, --include-removed)
  wp-hooks search-blocks <q>  Search block registrations and JS APIs
  wp-hooks search-docs <q>    Search documentation (--type, --category, --source) (since v1.1.0)
  wp-hooks validate <name>    Check if a hook name exists (exit code 0/1)

Maintenance:
  wp-hooks stats              Hook/block/API/doc counts per source
  wp-hooks rebuild-index      Rebuild FTS indexes if out of sync
```

### CLI Examples

```bash
# Search for checkout-related hooks
npx wp-hooks search "woocommerce_checkout"

# Search only filters
npx wp-hooks search "woocommerce_product" --type filter

# Validate a specific hook name
npx wp-hooks validate "woocommerce_before_order_itemmeta"

# Search for Gutenberg block APIs
npx wp-hooks search-blocks "InspectorControls"

# Search documentation (since v1.1.0)
npx wp-hooks search-docs "custom post type"

# Add all presets at once (since v1.1.0)
npx wp-hooks quick-add-all

# Re-index a specific source after updates
npx wp-hooks index --source woocommerce

# Update stale sources (since v1.1.0)
npx wp-hooks update

# Force full re-index (ignore file modification cache)
npx wp-hooks index --force

# See what you have indexed
npx wp-hooks stats
```

## How It Works

1. **Sources** are registered via the CLI — each points to a GitHub repo or local folder
2. **Indexing** clones/pulls the repo, scans PHP and JS/TS files, and extracts hooks using regex-based parsers
3. **Documentation indexing** *(since v1.1.0)* parses markdown handbooks using specialized parsers that extract metadata, code examples, and categorization
4. **Storage** uses SQLite with FTS5 full-text search and WAL mode for fast concurrent reads
5. **Incremental updates** skip files that haven't changed (mtime + content hash)
6. **Soft-delete tracking** marks hooks that were previously indexed but no longer found as `removed`
7. **Auto-update** *(since v1.1.0)* refreshes stale sources (>24h) in the background on server start
8. **The MCP server** exposes the database as tools over stdio — your AI assistant queries it in real-time

### Data Storage

All data lives in `~/.wp-devdocs-mcp/`:

```
~/.wp-devdocs-mcp/
  hooks.db          # SQLite database (FTS5, WAL mode)
  cache/            # Cloned repositories
```

## Version History

### v1.1.0

- **Documentation indexing** — 7 specialized parsers for WordPress handbooks (block editor, plugin, REST API, WP-CLI, admin, general)
- **3 new MCP tools** — `search_docs`, `get_doc`, `list_docs` for querying indexed documentation
- **Preset system** — 8 pre-configured sources with `quick-add` and `quick-add-all` CLI commands
- **Auto-update** — background refresh of stale sources (>24h) on each server start (opt-out: `WP_MCP_AUTO_UPDATE=false`)
- **`update` CLI command** — manual fetch and re-index of stale sources
- **`search-docs` CLI command** — search documentation from the terminal
- **`--content-type` option** — distinguish between source code and documentation sources
- **Enhanced `source:list`** — shows content type and last-indexed time

### v1.0.1

- Bug fixes (transaction-wrapped deletions, prepared statement cache, cross-platform paths)
- JSDoc annotations, ESLint 9 integration

### v1.0.0

- Initial release — PHP/JS hook extraction, block registration tracking, SQLite FTS5 search, incremental indexing, 4 MCP tools (`search_hooks`, `validate_hook`, `get_hook_context`, `search_block_apis`)

## Requirements

- Node.js 20+
- Git
- ~500MB disk space per large plugin source (WooCommerce, Gutenberg)

## License

MIT
