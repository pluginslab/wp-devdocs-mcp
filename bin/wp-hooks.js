#!/usr/bin/env node

import { Command } from 'commander';
import {
  addSource,
  listSources,
  getSource,
  removeSource,
  searchHooks,
  searchBlockApis,
  searchDocs,
  validateHook,
  getStats,
  rebuildFtsIndex,
  isSourceIndexed,
  closeDb,
} from '../src/db/sqlite.js';
import { indexSources } from '../src/indexer/index-manager.js';

const program = new Command();

program
  .name('wp-hooks')
  .description('WordPress hook indexer, doc searcher, and MCP server CLI')
  .version('2.0.0');

function printIndexStats(stats) {
  console.log(`  Files processed:   ${stats.files_processed}`);
  console.log(`  Files skipped:     ${stats.files_skipped}`);
  console.log(`  Hooks inserted:    ${stats.hooks_inserted}`);
  console.log(`  Hooks updated:     ${stats.hooks_updated}`);
  console.log(`  Hooks unchanged:   ${stats.hooks_skipped}`);
  console.log(`  Hooks removed:     ${stats.hooks_removed}`);
  console.log(`  Blocks indexed:    ${stats.blocks_indexed}`);
  console.log(`  APIs indexed:      ${stats.apis_indexed}`);
  console.log(`  Docs inserted:     ${stats.docs_inserted}`);
  console.log(`  Docs updated:      ${stats.docs_updated}`);
  console.log(`  Docs unchanged:    ${stats.docs_skipped}`);
  console.log(`  Docs removed:      ${stats.docs_removed}`);

  if (stats.errors.length > 0) {
    console.log(`\n  Errors (${stats.errors.length}):`);
    for (const err of stats.errors) {
      console.log(`    - ${err}`);
    }
  }
}

// --- source:add ---
program
  .command('source:add')
  .description('Add a new source to index')
  .requiredOption('--name <name>', 'Unique source name')
  .requiredOption('--type <type>', 'Source type: github-public, github-private, local-folder')
  .option('--repo <url>', 'Repository URL (for github types)')
  .option('--subfolder <path>', 'Subfolder within repo to index')
  .option('--path <path>', 'Local folder path (for local-folder type)')
  .option('--token-env <var>', 'Environment variable name containing GitHub token')
  .option('--branch <branch>', 'Git branch (default: main)', 'main')
  .option('--content-type <type>', 'Content type: source or docs (default: source)', 'source')
  .option('--no-index', 'Skip automatic indexing after adding')
  .action(async (opts) => {
    try {
      const existing = getSource(opts.name);
      if (existing) {
        console.error(`Source "${opts.name}" already exists. Remove it first.`);
        process.exit(1);
      }

      addSource({
        name: opts.name,
        type: opts.type,
        repo_url: opts.repo || null,
        subfolder: opts.subfolder || null,
        local_path: opts.path || null,
        token_env_var: opts.tokenEnv || null,
        branch: opts.branch,
        content_type: opts.contentType,
      });

      console.log(`Source "${opts.name}" added successfully (content_type: ${opts.contentType}).`);

      if (opts.index) {
        console.log(`\nIndexing "${opts.name}"...`);
        const stats = await indexSources({ sourceName: opts.name });
        console.log('\nIndexing complete:');
        printIndexStats(stats);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- source:list ---

function formatRelativeTime(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString + 'Z').getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

program
  .command('source:list')
  .description('List all configured sources')
  .action(() => {
    try {
      const sources = listSources();
      if (sources.length === 0) {
        console.log('No sources configured. Use "wp-hooks source:add" to add one.');
        return;
      }

      console.log(`\n${'Name'.padEnd(25)} ${'Type'.padEnd(18)} ${'Content'.padEnd(10)} ${'Branch'.padEnd(10)} ${'Indexed'.padEnd(10)} ${'Last indexed'.padEnd(14)} Details`);
      console.log('-'.repeat(124));

      for (const s of sources) {
        const details = s.repo_url || s.local_path || '';
        const subfolder = s.subfolder ? ` [${s.subfolder}]` : '';
        const indexed = isSourceIndexed(s.id) ? 'yes' : 'no';
        const contentType = s.content_type || 'source';
        const lastIndexed = formatRelativeTime(s.last_indexed_at);
        console.log(
          `${s.name.padEnd(25)} ${s.type.padEnd(18)} ${contentType.padEnd(10)} ${(s.branch || 'main').padEnd(10)} ${indexed.padEnd(10)} ${lastIndexed.padEnd(14)} ${details}${subfolder}`
        );
      }
      console.log('');
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- source:remove ---
program
  .command('source:remove <name>')
  .description('Remove a source and all its indexed data')
  .action((name) => {
    try {
      const removed = removeSource(name);
      if (!removed) {
        console.error(`Source "${name}" not found.`);
        process.exit(1);
      }
      console.log(`Source "${name}" removed along with all indexed data.`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- index ---
program
  .command('index')
  .description('Index all enabled sources (or a specific one)')
  .option('--source <name>', 'Index a specific source only')
  .option('--force', 'Ignore mtime cache and re-index everything', false)
  .action(async (opts) => {
    try {
      const stats = await indexSources({
        sourceName: opts.source,
        force: opts.force,
      });

      console.log('\nIndexing complete:');
      console.log(`  Sources processed: ${stats.sources_processed}`);
      printIndexStats(stats);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- search ---
program
  .command('search <query>')
  .description('Search indexed hooks')
  .option('--type <type>', 'Filter by hook type')
  .option('--source <name>', 'Filter by source name')
  .option('--limit <n>', 'Max results', '20')
  .option('--include-removed', 'Include removed hooks', false)
  .action((query, opts) => {
    try {
      const results = searchHooks(query, {
        type: opts.type,
        source: opts.source,
        includeRemoved: opts.includeRemoved,
        limit: parseInt(opts.limit, 10),
      });

      if (results.length === 0) {
        console.log(`No hooks found matching "${query}".`);
        return;
      }

      console.log(`\nFound ${results.length} hook(s) matching "${query}":\n`);

      for (const h of results) {
        console.log(`  ${h.name}`);
        console.log(`    Type: ${h.type} | Source: ${h.source_name}`);
        console.log(`    File: ${h.file_path}:${h.line_number}`);
        if (h.is_dynamic) console.log('    Dynamic: yes');
        if (h.status === 'removed') console.log('    Status: REMOVED');
        if (h.class_name) console.log(`    Class: ${h.class_name}`);
        if (h.php_function) console.log(`    Function: ${h.php_function}()`);
        if (h.params) console.log(`    Params: ${h.params}`);
        if (h.inferred_description) console.log(`    Description: ${h.inferred_description}`);
        if (h.docblock) console.log(`    Docblock: ${h.docblock.replace(/\n/g, '\n             ')}`);
        console.log(`    ID: ${h.id}`);
        console.log('');
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- search-blocks ---
program
  .command('search-blocks <query>')
  .description('Search block registrations and WP JS API usages')
  .option('--limit <n>', 'Max results per category', '20')
  .action((query, opts) => {
    try {
      const { blocks, apis } = searchBlockApis(query, {
        limit: parseInt(opts.limit, 10),
      });

      if (blocks.length === 0 && apis.length === 0) {
        console.log(`No block registrations or API usages found matching "${query}".`);
        return;
      }

      if (blocks.length > 0) {
        console.log(`\nBlock Registrations (${blocks.length}):\n`);
        for (const b of blocks) {
          console.log(`  ${b.block_name || 'unknown'}`);
          console.log(`    Source: ${b.source_name} | File: ${b.file_path}:${b.line_number}`);
          if (b.block_title) console.log(`    Title: ${b.block_title}`);
          if (b.block_category) console.log(`    Category: ${b.block_category}`);
          if (b.code_context) console.log(`    Context: ${b.code_context.split('\n').slice(0, 5).join('\n             ')}`);
          console.log('');
        }
      }

      if (apis.length > 0) {
        console.log(`API Usages (${apis.length}):\n`);
        for (const a of apis) {
          console.log(`  ${a.api_call}`);
          console.log(`    Source: ${a.source_name} | File: ${a.file_path}:${a.line_number}`);
          console.log(`    Namespace: ${a.namespace} | Method: ${a.method}`);
          if (a.code_context) console.log(`    Context: ${a.code_context.split('\n').slice(0, 3).join('\n             ')}`);
          console.log('');
        }
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- search-docs ---
program
  .command('search-docs <query>')
  .description('Search indexed WordPress documentation')
  .option('--type <type>', 'Filter by doc type (guide, tutorial, reference, api, howto, faq, general)')
  .option('--category <cat>', 'Filter by category (block-editor, plugins, rest-api, wp-cli, admin)')
  .option('--source <name>', 'Filter by source name')
  .option('--limit <n>', 'Max results', '20')
  .action((query, opts) => {
    try {
      const results = searchDocs(query, {
        doc_type: opts.type,
        category: opts.category,
        source: opts.source,
        limit: parseInt(opts.limit, 10),
      });

      if (results.length === 0) {
        console.log(`No documentation found matching "${query}".`);
        return;
      }

      console.log(`\nFound ${results.length} doc(s) matching "${query}":\n`);

      for (const d of results) {
        console.log(`  ${d.title}`);
        console.log(`    Type: ${d.doc_type} | Category: ${d.category || 'general'} | Source: ${d.source_name}`);
        console.log(`    Slug: ${d.slug}`);
        if (d.subcategory) console.log(`    Subcategory: ${d.subcategory}`);
        if (d.description) console.log(`    Description: ${d.description.slice(0, 150)}${d.description.length > 150 ? '...' : ''}`);
        console.log(`    ID: ${d.id}`);
        console.log('');
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- validate ---
program
  .command('validate <hook-name>')
  .description('Validate if a hook name exists (exit code 0=valid, 1=not found)')
  .action((hookName) => {
    try {
      const result = validateHook(hookName);

      if (result.status === 'VALID') {
        console.log(`VALID — "${hookName}" found in ${result.hooks.length} location(s):`);
        for (const h of result.hooks) {
          console.log(`  ${h.source_name}: ${h.file_path}:${h.line_number} (${h.type})`);
        }
        process.exit(0);
      }

      if (result.status === 'REMOVED') {
        console.log(`REMOVED — "${hookName}" was found but has been removed.`);
        process.exit(1);
      }

      console.log(`NOT FOUND — "${hookName}" does not exist in any indexed source.`);
      if (result.similar.length > 0) {
        console.log('\nDid you mean:');
        for (const s of result.similar) {
          console.log(`  ${s.name} (${s.type}) [${s.source_name}]`);
        }
      }
      process.exit(1);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- stats ---
program
  .command('stats')
  .description('Show indexing statistics')
  .action(() => {
    try {
      const stats = getStats();

      console.log('\nOverall Statistics:');
      console.log(`  Sources:             ${stats.totals.sources}`);
      console.log(`  Active hooks:        ${stats.totals.active_hooks}`);
      console.log(`  Removed hooks:       ${stats.totals.removed_hooks}`);
      console.log(`  Block registrations: ${stats.totals.block_registrations}`);
      console.log(`  API usages:          ${stats.totals.api_usages}`);
      console.log(`  Documentation pages: ${stats.totals.docs}`);

      if (stats.per_source.length > 0) {
        console.log('\nPer Source:');
        console.log(`  ${'Name'.padEnd(25)} ${'Type'.padEnd(8)} ${'Hooks'.padEnd(8)} ${'Removed'.padEnd(10)} ${'Blocks'.padEnd(8)} ${'APIs'.padEnd(8)} ${'Docs'.padEnd(8)} Files`);
        console.log('  ' + '-'.repeat(90));
        for (const s of stats.per_source) {
          console.log(
            `  ${s.name.padEnd(25)} ${(s.content_type || 'source').padEnd(8)} ${String(s.hooks).padEnd(8)} ${String(s.removed_hooks).padEnd(10)} ${String(s.blocks).padEnd(8)} ${String(s.apis).padEnd(8)} ${String(s.docs).padEnd(8)} ${s.files}`
          );
        }
      }
      console.log('');
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// --- rebuild-index ---
program
  .command('rebuild-index')
  .description('Rebuild FTS indexes (recovery for out-of-sync full-text search)')
  .action(() => {
    try {
      rebuildFtsIndex();
      console.log('FTS indexes rebuilt successfully (hooks, blocks, APIs, docs).');
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program.parse();
