import fg from 'fast-glob';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  upsertDoc,
  markDocsRemoved,
  getIndexedFile,
  upsertIndexedFile,
  getActiveDocId,
} from '../db/sqlite.js';
import { DocParserRegistry, extractFrontmatter } from './parsers/base-doc-parser.js';
import { BlockEditorParser } from './parsers/block-editor-parser.js';
import { PluginHandbookParser } from './parsers/plugin-handbook-parser.js';
import { RestApiParser } from './parsers/rest-api-parser.js';
import { WpCliParser } from './parsers/wp-cli-parser.js';
import { AdminHandbookParser } from './parsers/admin-handbook-parser.js';
import { GeneralDocParser } from './parsers/general-doc-parser.js';

const MD_PATTERNS = ['**/*.md'];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/vendor/**',
  '**/images/**',
  '**/img/**',
  '**/assets/**',
  '**/static/**',
  '**/CHANGELOG.md',
  '**/changelog.md',
  '**/CODE_OF_CONDUCT.md',
  '**/CONTRIBUTING.md',
  '**/LICENSE.md',
];

// Build the parser registry — specific parsers first, general fallback last
const registry = new DocParserRegistry();
registry.register(new BlockEditorParser());
registry.register(new PluginHandbookParser());
registry.register(new RestApiParser());
registry.register(new WpCliParser());
registry.register(new AdminHandbookParser());
registry.register(new GeneralDocParser());

/**
 * Index markdown documentation from a docs-type source.
 * Mirrors the pattern of indexSource() in index-manager.js.
 */
export async function indexDocsSource(source, localPath, force, stats) {
  const files = await fg(MD_PATTERNS, {
    cwd: localPath,
    ignore: IGNORE_PATTERNS,
    absolute: false,
    onlyFiles: true,
  });

  console.error(`Found ${files.length} markdown files to check in ${source.name}`);

  const activeDocIds = [];

  for (const file of files) {
    const fullPath = `${localPath}/${file}`;

    try {
      const fileStat = statSync(fullPath);
      const mtimeMs = fileStat.mtimeMs;

      // Cache indexed file lookup (used for both mtime and content hash checks)
      const indexed = force ? null : getIndexedFile(source.id, file);

      // Check mtime for incremental skip
      if (indexed && indexed.mtime_ms === mtimeMs) {
        const docId = getActiveDocId(source.id, file);
        if (docId) activeDocIds.push(docId);
        stats.files_skipped++;
        continue;
      }

      const content = readFileSync(fullPath, 'utf-8');
      const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Skip if content hash matches
      if (indexed && indexed.content_hash === contentHash) {
        const docId = getActiveDocId(source.id, file);
        if (docId) activeDocIds.push(docId);
        upsertIndexedFile(source.id, file, mtimeMs, contentHash);
        stats.files_skipped++;
        continue;
      }

      // Extract frontmatter for parser selection
      const { frontmatter } = extractFrontmatter(content);

      // Select parser
      const parser = registry.getParser(file, frontmatter, source.name);
      if (!parser) {
        // Should never happen with GeneralDocParser as fallback
        continue;
      }

      // Parse
      const docData = parser.parse(content, file, source.id);
      if (!docData || !docData.title) {
        continue;
      }

      // Upsert
      const result = upsertDoc(docData);
      activeDocIds.push(result.id);

      if (result.action === 'inserted') stats.docs_inserted++;
      else if (result.action === 'updated') stats.docs_updated++;
      else stats.docs_skipped++;

      // Track file
      upsertIndexedFile(source.id, file, mtimeMs, contentHash);
      stats.files_processed++;
    } catch (err) {
      const msg = `Error indexing doc ${file}: ${err.message}`;
      console.error(msg);
      stats.errors.push(msg);
    }
  }

  // Soft-delete docs no longer found in this source
  const removed = markDocsRemoved(source.id, activeDocIds);
  stats.docs_removed += removed;
}
