# Roadmap

Feature ideas sourced from the WordPress MCP ecosystem, community tools, and identified gaps in the developer documentation + AI space.

**Landscape context:** wp-devdocs-mcp is the only MCP server focused on giving AI assistants a verified, searchable database of WordPress hooks and developer documentation parsed from actual source code. The closest comparable project is [WordPress/agent-skills](https://github.com/WordPress/agent-skills) (787 stars), which provides static knowledge files rather than dynamic, searchable data. Other WordPress MCP servers (mcp-adapter, Automattic/wordpress-mcp, InstaWP, etc.) are all focused on site operations, not developer documentation.

Key repos for reference:
- [WordPress/agent-skills](https://github.com/WordPress/agent-skills) — Curated markdown skills for AI assistants (static, not searchable)
- [wp-hooks/wordpress-core-hooks](https://github.com/wp-hooks/wordpress-core-hooks) — Structured JSON of all WordPress core hooks (by @johnbillion)
- [wp-hooks/generator](https://github.com/wp-hooks/generator) — Tool that generates hook JSON from source code
- [WordPress/mcp-adapter](https://github.com/WordPress/mcp-adapter) — Official WP Abilities API → MCP bridge
- [mcp-wp/ai-command](https://github.com/mcp-wp/ai-command) — CloudFest 2025 hackathon winner, WP-CLI as MCP host
- [CodeWP](https://codewp.ai) — Commercial AI code generator fine-tuned on WordPress

**Key validation:** developer.wordpress.org/reference was not updated between WordPress 6.4 and 6.9.1 (over two years). Our approach of parsing actual source code is more reliable than depending on official docs.

---

## Shipped

### ✅ `search_theme_json_properties` + `get_theme_json_property` — theme.json property dictionary

Indexes every valid `theme.json` property from the Gutenberg JSON Schema cross-referenced with `class-wp-theme-json.php` constants (`VALID_SETTINGS`, `VALID_STYLES`, `PRESETS_METADATA`, etc.). Property records carry a finite `value_origin` taxonomy (enum / boolean / css_length / css_color / css_keyword / preset_ref:{type} / string / object / array / alias). Per-block (`styles.blocks.core/paragraph.*`) and per-element (`styles.elements.button.*`) paths normalised via placeholder substitution; unknown block names flagged as `VALID_PATH_UNKNOWN_BLOCK`. CLI: `wp-hooks search-theme-json`, `wp-hooks get-theme-json-property`. Quick-add preset: `theme-json`.

---

## High priority

### `search_functions` — WordPress function reference tool

Extend beyond hooks to index WordPress core functions, classes, and methods.

**Why:** AI assistants frequently hallucinate WordPress function names, parameters, or return types. We already index hooks — adding function signatures would make wp-devdocs-mcp the definitive WordPress API reference for AI. No other MCP tool provides this.

**Scope:**
- Extend PHP parser to extract function definitions (name, params, return type, docblock)
- New tool: `search_functions` — `{ query, source? }` → `{ functions: [{ name, file, line, params, returnType, description, since }] }`
- Index `@since` version tags for version tracking
- Store in existing SQLite DB with FTS5

---

### Hook version tracking and deprecation alerts

Track which WordPress version introduced or deprecated each hook.

**Why:** AI agents often suggest deprecated hooks without knowing they're deprecated. Version tracking lets us flag deprecations in search results and suggest replacements. This gap was noted across the ecosystem — no tool currently tracks migration paths.

**Scope:**
- Parse `@since` and `@deprecated` tags from docblocks during indexing
- Add `introduced_in` and `deprecated_in` columns to the hooks table
- Flag deprecated hooks in `search_hooks` results with replacement suggestions
- New tool: `check_deprecations` — `{ hook_or_function, wp_version? }` → `{ status, replacement?, since }`
- Parse `_deprecated_hook()` and `_deprecated_function()` calls for replacement mappings

---

### Hook usage examples from WordPress core

For each hook, index where WordPress core itself calls `do_action()` or `apply_filters()`.

**Why:** Showing how WordPress core uses a hook is the best documentation. When an AI finds a hook via `search_hooks`, it should also see the canonical usage context — what parameters are passed, in what order, and what the surrounding code does. We already parse source files; we just need to capture the call sites, not just the registration sites.

**Scope:**
- Extend PHP parser to capture `do_action()` and `apply_filters()` call sites
- Store call site context (file, line, surrounding code, parameters passed)
- Enrich `get_hook_context` results with call site examples
- Link hooks to their trigger points, not just their registration points

---

### Integrate wp-hooks JSON as supplementary data source

Merge structured hook data from [wp-hooks/wordpress-core-hooks](https://github.com/wp-hooks/wordpress-core-hooks) with our parsed data.

**Why:** The wp-hooks org maintains carefully structured JSON with parameter types, `@since` tags, and docblock descriptions — generated via CI for every WordPress release. Merging this with our FTS5 database would enrich results with type information we may miss during parsing, and provide a cross-validation layer.

**Scope:**
- Add wp-hooks/wordpress-core-hooks as an optional data source
- Merge during indexing: our parsed data + their structured JSON
- Use their data to fill gaps (parameter types, descriptions) and validate our parsing
- Flag discrepancies between our parsed data and theirs

---

## Medium priority

### Hook execution order mapping

Track which hooks fire in sequence during a WordPress request lifecycle.

**Why:** Understanding hook execution order is essential for WordPress development. Knowing that `init` fires before `wp_loaded` fires before `template_redirect` helps the AI place code in the right hook. Currently this knowledge exists only in blog posts and developer experience — not in any structured, queryable format.

**Scope:**
- New tool: `get_hook_order` — `{ context?: 'frontend' | 'admin' | 'rest' | 'cron' }` → ordered list of hooks that fire during that request type
- Build from a combination of source analysis and curated data
- Include relative timing info (early init, late init, rendering, shutdown)

---

### Best practice guidance layer

Combine verified hook data with contextual usage guidance.

**Why:** This bridges the gap between wp-devdocs-mcp (verified data, no guidance) and WordPress/agent-skills (guidance, no verified data). An AI that knows both "this hook exists with these parameters" AND "here's the recommended way to use it" would be uniquely powerful. Identified as the biggest gap across the ecosystem.

**Scope:**
- Bundle relevant agent-skills knowledge alongside hook/function search results
- When searching for `wp_enqueue_block_editor_assets`, return both the hook signature AND best-practice notes from the block development skill
- Could integrate as an optional enrichment layer — when agent-skills content is available, append it to results
- Start with the 13 skills available in WordPress/agent-skills

---

### REST API endpoint indexing

Extend indexing to cover registered REST API routes from plugins.

**Why:** AI agents frequently need to interact with WordPress REST API endpoints but guess at URLs, parameters, and authentication requirements. Indexing REST API route registrations (`register_rest_route()`) would make these discoverable. Pairs well with the `playground_request` tool in wp-playground-mcp.

**Scope:**
- Extend PHP parser to capture `register_rest_route()` calls
- Index: namespace, route pattern, methods, permission callback, args schema
- New tool: `search_rest_routes` — `{ query, namespace? }` → `{ routes: [...] }`
- Cross-reference with hooks that fire during REST requests

---

### Automated release tracking

Auto-regenerate the hook database when new WordPress versions are tagged.

**Why:** The wp-hooks org does this via GitHub Actions for every WordPress release. We should too — ensures our database is always current and users don't need to manually re-index. Especially important given the developer.wordpress.org documentation freshness issues.

**Scope:**
- GitHub Actions workflow triggered on WordPress core release tags
- Re-index core hooks and functions
- Publish updated database or trigger a `wp-devdocs-mcp update` notification
- Version the database so users can query by WordPress version

---

## Future ideas

### Cross-plugin hook conflict detection

When indexing multiple plugins, detect hooks that modify the same data and could conflict.

**Why:** A common source of WordPress bugs is two plugins hooking into the same filter with incompatible modifications. No tool currently surfaces this information.

**Scope:** Analyze indexed hooks across multiple sources to find overlapping `add_filter` calls on the same hook. Surface potential conflicts in search results.

---

### Migration assistant

When hooks or functions are deprecated, automatically suggest the replacement with parameter mapping.

**Why:** WordPress deprecates hooks and functions across major versions. AI agents need to know not just that something is deprecated, but exactly what to use instead and how parameters map.

**Scope:** Parse `_deprecated_hook()`, `_deprecated_function()`, and `_deprecated_argument()` calls to build a migration graph. New tool: `get_migration_path` — `{ old_hook_or_function }` → `{ replacement, param_changes, since }`.

---

### PHPStan / type-level integration

Provide parameter type information for hook callbacks that could be consumed by static analysis tools.

**Why:** PHPStan and Psalm are increasingly used in WordPress development. Providing hook callback type signatures would improve static analysis accuracy. The wp-hooks org already has TypeScript interfaces for this; we could provide the PHP equivalent.

**Scope:** Generate type stubs or PHPDoc annotations from indexed hook data. Could be exposed as an MCP resource rather than a tool.

---

### Interactive hook taxonomy (MCP resource)

Expose a browseable hook taxonomy organized by subsystem.

**Why:** Sometimes the AI needs to explore what hooks are available in a specific area (e.g., "what hooks exist for the block editor?" or "show me all REST API hooks") rather than searching for a specific name.

**Scope:** MCP resource (not tool) that categorizes hooks by subsystem: admin, frontend, REST, cron, block editor, customizer, etc. Built from file path analysis and hook naming conventions.
