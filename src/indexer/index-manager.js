import fg from 'fast-glob';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchSource } from './sources/index.js';
import { parsePhpFile } from './php-parser.js';
import { parseJsFile } from './js-parser.js';
import {
  listSources,
  getSource,
  upsertHook,
  markHooksRemoved,
  upsertBlockRegistration,
  upsertApiUsage,
  getIndexedFile,
  upsertIndexedFile,
  updateSourceLastIndexed,
} from '../db/sqlite.js';
import { indexDocsSource } from '../docs/doc-index-manager.js';

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/tests/**',
  '**/test/**',
  '**/__tests__/**',
  '**/spec/**',
];

const PHP_PATTERNS = ['**/*.php'];
const JS_PATTERNS = ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'];

/**
 * Index all enabled sources or a specific source.
 * @param {object} opts - { sourceName, force }
 * @returns {object} Stats about the indexing run
 */
export async function indexSources(opts = {}) {
  const { sourceName, force = false } = opts;

  let sources;
  if (sourceName) {
    const source = getSource(sourceName);
    if (!source) throw new Error(`Source not found: ${sourceName}`);
    if (!source.enabled) throw new Error(`Source "${sourceName}" is disabled`);
    sources = [source];
  } else {
    sources = listSources().filter(s => s.enabled);
  }

  if (sources.length === 0) {
    return { message: 'No enabled sources found. Add a source first.' };
  }

  const stats = {
    sources_processed: 0,
    files_processed: 0,
    files_skipped: 0,
    hooks_inserted: 0,
    hooks_updated: 0,
    hooks_skipped: 0,
    hooks_removed: 0,
    blocks_indexed: 0,
    apis_indexed: 0,
    docs_inserted: 0,
    docs_updated: 0,
    docs_skipped: 0,
    docs_removed: 0,
    errors: [],
  };

  for (const source of sources) {
    try {
      console.error(`Fetching source: ${source.name} (${source.type})...`);
      const localPath = await fetchSource(source);
      console.error(`Indexing source: ${source.name} from ${localPath} (${source.content_type || 'source'})`);

      if (source.content_type === 'docs') {
        await indexDocsSource(source, localPath, force, stats);
      } else {
        await indexSource(source, localPath, force, stats);
      }
      stats.sources_processed++;
      updateSourceLastIndexed(source.id);
    } catch (err) {
      const msg = `Error processing source "${source.name}": ${err.message}`;
      console.error(msg);
      stats.errors.push(msg);
    }
  }

  return stats;
}

/**
 * Index a single source — scans files, parses hooks/blocks/APIs, and upserts into the database.
 * @param {object} source - Source row from the database
 * @param {string} localPath - Absolute path to the source on disk
 * @param {boolean} force - Skip mtime/hash caching when true
 * @param {object} stats - Mutable stats object to accumulate counts
 */
async function indexSource(source, localPath, force, stats) {
  // Scan for PHP and JS/TS files
  const files = await fg([...PHP_PATTERNS, ...JS_PATTERNS], {
    cwd: localPath,
    ignore: IGNORE_PATTERNS,
    absolute: false,
    onlyFiles: true,
  });

  console.error(`Found ${files.length} files to check in ${source.name}`);

  for (const file of files) {
    const fullPath = join(localPath, file);

    try {
      const fileStat = statSync(fullPath);
      const mtimeMs = fileStat.mtimeMs;

      // Check mtime for incremental skip
      const indexed = !force ? getIndexedFile(source.id, file) : null;
      if (indexed && indexed.mtime_ms === mtimeMs) {
        stats.files_skipped++;
        continue;
      }

      const content = readFileSync(fullPath, 'utf-8');
      const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Skip if content hash matches (handles moved files / touched timestamps)
      if (indexed && indexed.content_hash === contentHash) {
        upsertIndexedFile(source.id, file, mtimeMs, contentHash);
        stats.files_skipped++;
        continue;
      }

      const isPhp = file.endsWith('.php');
      const activeHookIds = [];

      if (isPhp) {
        const hooks = parsePhpFile(content, file, source.id);
        for (const hook of hooks) {
          const result = upsertHook(hook);
          activeHookIds.push(result.id);
          if (result.action === 'inserted') stats.hooks_inserted++;
          else if (result.action === 'updated') stats.hooks_updated++;
          else stats.hooks_skipped++;
        }
      } else {
        const { hooks, blocks, apis } = parseJsFile(content, file, source.id);

        for (const hook of hooks) {
          const result = upsertHook(hook);
          activeHookIds.push(result.id);
          if (result.action === 'inserted') stats.hooks_inserted++;
          else if (result.action === 'updated') stats.hooks_updated++;
          else stats.hooks_skipped++;
        }

        for (const block of blocks) {
          upsertBlockRegistration(block);
          stats.blocks_indexed++;
        }

        for (const api of apis) {
          upsertApiUsage(api);
          stats.apis_indexed++;
        }
      }

      // Soft-delete hooks that were in this file but no longer found
      const removed = markHooksRemoved(source.id, file, activeHookIds);
      stats.hooks_removed += removed;

      // Track this file as indexed
      upsertIndexedFile(source.id, file, mtimeMs, contentHash);
      stats.files_processed++;
    } catch (err) {
      const msg = `Error indexing file ${file}: ${err.message}`;
      console.error(msg);
      stats.errors.push(msg);
    }
  }
}
