#!/usr/bin/env node

/**
 * Integration tests for the docs indexing and search system.
 * Run: node test/docs-test.js
 *
 * Uses an in-memory database to avoid polluting the real DB.
 */

import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Parser unit tests ---

import { BaseDocParser, DocParserRegistry } from '../src/docs/parsers/base-doc-parser.js';
import { BlockEditorParser } from '../src/docs/parsers/block-editor-parser.js';
import { PluginHandbookParser } from '../src/docs/parsers/plugin-handbook-parser.js';
import { RestApiParser } from '../src/docs/parsers/rest-api-parser.js';
import { WpCliParser } from '../src/docs/parsers/wp-cli-parser.js';
import { AdminHandbookParser } from '../src/docs/parsers/admin-handbook-parser.js';
import { GeneralDocParser } from '../src/docs/parsers/general-doc-parser.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.message}`);
  }
}

// --- BaseDocParser utility tests ---

console.log('\n--- BaseDocParser utilities ---');

const base = new GeneralDocParser(); // Use GeneralDocParser since BaseDocParser is abstract

test('extractFrontmatter parses YAML frontmatter', () => {
  const content = `---
title: My Page
category: plugins
---

# My Page

Content here.`;

  const { frontmatter, body } = base.extractFrontmatter(content);
  assert.equal(frontmatter.title, 'My Page');
  assert.equal(frontmatter.category, 'plugins');
  assert.ok(body.startsWith('# My Page'));
});

test('extractFrontmatter handles no frontmatter', () => {
  const content = '# Just a heading\n\nSome content.';
  const { frontmatter, body } = base.extractFrontmatter(content);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, content);
});

test('extractTitle gets title from frontmatter', () => {
  assert.equal(base.extractTitle('body', { title: 'FM Title' }), 'FM Title');
});

test('extractTitle gets title from H1', () => {
  assert.equal(base.extractTitle('# My H1 Title\n\nContent', {}), 'My H1 Title');
});

test('extractDescription gets first paragraph', () => {
  const body = '# Title\n\nThis is the first paragraph of content.\n\n## Next section';
  const desc = base.extractDescription(body);
  assert.equal(desc, 'This is the first paragraph of content.');
});

test('extractCodeExamples finds fenced code blocks', () => {
  const body = 'Text\n\n```php\necho "hello";\n```\n\nMore text\n\n```js\nconsole.log("hi");\n```';
  const examples = JSON.parse(base.extractCodeExamples(body));
  assert.equal(examples.length, 2);
  assert.equal(examples[0].language, 'php');
  assert.equal(examples[1].language, 'js');
});

test('generateSlug creates URL-safe slug from path', () => {
  assert.equal(base.generateSlug('getting-started/tutorial.md'), 'getting-started--tutorial');
  assert.equal(base.generateSlug('REST API/endpoints.md'), 'rest-api--endpoints');
});

test('generateContentHash is deterministic', () => {
  const data = { title: 'Test', content: 'Body', doc_type: 'guide', category: 'plugins' };
  const hash1 = base.generateContentHash(data);
  const hash2 = base.generateContentHash(data);
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 16);
});

test('inferDocType detects reference docs', () => {
  assert.equal(base.inferDocType('API reference documentation', {}), 'reference');
});

test('inferDocType detects tutorials', () => {
  assert.equal(base.inferDocType('Step-by-step tutorial for beginners', {}), 'tutorial');
});

test('inferDocType falls back to general', () => {
  assert.equal(base.inferDocType('Some random content', {}), 'general');
});

// --- Parser canParse tests ---

console.log('\n--- Parser canParse ---');

const blockEditor = new BlockEditorParser();
const pluginHandbook = new PluginHandbookParser();
const restApi = new RestApiParser();
const wpCli = new WpCliParser();
const adminHandbook = new AdminHandbookParser();
const general = new GeneralDocParser();

test('BlockEditorParser matches gutenberg docs/', () => {
  assert.ok(blockEditor.canParse('docs/getting-started/README.md', {}, 'gutenberg-docs'));
  assert.ok(!blockEditor.canParse('src/blocks/index.js', {}, 'gutenberg-docs'));
  assert.ok(!blockEditor.canParse('docs/README.md', {}, 'plugin-handbook'));
});

test('PluginHandbookParser matches plugin sources', () => {
  assert.ok(pluginHandbook.canParse('hooks/index.md', {}, 'plugin-handbook'));
  assert.ok(!pluginHandbook.canParse('hooks/index.md', {}, 'rest-api-handbook'));
});

test('RestApiParser matches rest-api and wp-api sources', () => {
  assert.ok(restApi.canParse('endpoints.md', {}, 'rest-api-handbook'));
  assert.ok(restApi.canParse('endpoints.md', {}, 'wp-api-docs'));
  assert.ok(!restApi.canParse('endpoints.md', {}, 'plugin-handbook'));
});

test('WpCliParser matches wp-cli sources', () => {
  assert.ok(wpCli.canParse('commands.md', {}, 'wp-cli-handbook'));
  assert.ok(!wpCli.canParse('commands.md', {}, 'admin-handbook'));
});

test('AdminHandbookParser matches admin sources', () => {
  assert.ok(adminHandbook.canParse('security.md', {}, 'admin-handbook'));
  assert.ok(!adminHandbook.canParse('security.md', {}, 'wp-cli-handbook'));
});

test('GeneralDocParser always matches (fallback)', () => {
  assert.ok(general.canParse('anything.md', {}, 'any-source'));
});

// --- Parser registry ---

console.log('\n--- DocParserRegistry ---');

const registry = new DocParserRegistry();
registry.register(blockEditor);
registry.register(pluginHandbook);
registry.register(restApi);
registry.register(wpCli);
registry.register(adminHandbook);
registry.register(general);

test('Registry returns specialized parser before general', () => {
  const parser = registry.getParser('docs/blocks/README.md', {}, 'gutenberg-docs');
  assert.ok(parser instanceof BlockEditorParser);
});

test('Registry falls back to GeneralDocParser', () => {
  const parser = registry.getParser('random.md', {}, 'unknown-source');
  assert.ok(parser instanceof GeneralDocParser);
});

// --- Parser parse tests ---

console.log('\n--- Parser parse output ---');

test('PluginHandbookParser produces correct doc structure', () => {
  const content = `---
title: Plugin Basics
---

# Plugin Basics

WordPress plugins allow you to extend functionality. Use \`add_action('init', 'my_func')\` to hook in.

\`\`\`php
add_action('init', function() {
  register_post_type('book');
});
\`\`\`
`;

  const doc = pluginHandbook.parse(content, 'basics/index.md', 42);
  assert.equal(doc.title, 'Plugin Basics');
  assert.equal(doc.category, 'plugins');
  assert.equal(doc.source_id, 42);
  assert.equal(doc.file_path, 'basics/index.md');
  assert.ok(doc.slug);
  assert.ok(doc.content_hash);
  assert.ok(doc.content.includes('WordPress plugins'));
  assert.ok(doc.code_examples);
  const examples = JSON.parse(doc.code_examples);
  assert.equal(examples[0].language, 'php');
});

test('RestApiParser extracts endpoints', () => {
  const content = `# Posts Endpoint

The posts endpoint allows CRUD operations.

GET /wp/v2/posts
POST /wp/v2/posts

\`\`\`
GET /wp/v2/posts?per_page=10
\`\`\`
`;

  const doc = restApi.parse(content, 'endpoints/posts.md', 10);
  assert.equal(doc.category, 'rest-api');
  assert.equal(doc.doc_type, 'api');
  const meta = JSON.parse(doc.metadata);
  assert.ok(meta.endpoints.length >= 2);
});

test('WpCliParser extracts commands', () => {
  const content = `# WP Post List

List posts with wp post list.

\`\`\`
wp post list --post_type=page
\`\`\`

## Options

--format=<format>
--post_type=<type>
`;

  const doc = wpCli.parse(content, 'commands/post-list.md', 20);
  assert.equal(doc.category, 'wp-cli');
  const meta = JSON.parse(doc.metadata);
  assert.ok(meta.commands && meta.commands.length > 0);
  assert.ok(meta.options && meta.options.length > 0);
});

test('BlockEditorParser extracts @wordpress/ package refs', () => {
  const content = `# Block Editor Guide

Use @wordpress/blocks and @wordpress/element to build custom blocks.

\`\`\`js
import { registerBlockType } from '@wordpress/blocks';
\`\`\`
`;

  const doc = blockEditor.parse(content, 'docs/getting-started/intro.md', 5);
  assert.equal(doc.category, 'block-editor');
  const meta = JSON.parse(doc.metadata);
  assert.ok(meta.package_refs.includes('@wordpress/blocks'));
  assert.ok(meta.package_refs.includes('@wordpress/element'));
});

test('AdminHandbookParser extracts config defines', () => {
  const content = `# wp-config.php

Add the following to wp-config.php:

\`\`\`php
define('WP_DEBUG', true);
define('WP_MEMORY_LIMIT', '256M');
\`\`\`
`;

  const doc = adminHandbook.parse(content, 'configuration/wp-config.md', 15);
  assert.equal(doc.category, 'admin');
  const meta = JSON.parse(doc.metadata);
  assert.ok(meta.config_defines.includes('WP_DEBUG'));
  assert.ok(meta.config_defines.includes('WP_MEMORY_LIMIT'));
});

// --- Presets test ---

console.log('\n--- Presets ---');

import { getPreset, listPresets } from '../src/presets.js';

test('listPresets returns all presets', () => {
  const presets = listPresets();
  assert.ok(presets.length >= 8);
  const names = presets.map(p => p.name);
  assert.ok(names.includes('wp-core'));
  assert.ok(names.includes('gutenberg-docs'));
  assert.ok(names.includes('plugin-handbook'));
  assert.ok(names.includes('rest-api-handbook'));
  assert.ok(names.includes('wp-cli-handbook'));
  assert.ok(names.includes('admin-handbook'));
});

test('getPreset returns correct preset', () => {
  const preset = getPreset('gutenberg-docs');
  assert.equal(preset.content_type, 'docs');
  assert.equal(preset.branch, 'trunk');
  assert.ok(preset.repo_url.includes('gutenberg'));
});

test('getPreset returns null for unknown', () => {
  assert.equal(getPreset('nonexistent'), null);
});

// --- Summary ---

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
