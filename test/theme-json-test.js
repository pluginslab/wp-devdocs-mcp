#!/usr/bin/env node

/**
 * theme.json property indexing integration tests.
 * Requires the `theme-json` source to be indexed first:
 *   node bin/wp-hooks.js quick-add theme-json
 *
 * Run: node test/theme-json-test.js
 */

import {
  getStats,
  getThemeJsonProperty,
  searchThemeJsonProperties,
  closeDb,
} from '../src/db/sqlite.js';
import { normalisePath } from '../src/indexer/theme-json/path-utils.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\nRunning theme.json property tests...\n');

// --- Verify prerequisites ---
const stats = getStats();
assert(
  stats.totals.theme_json_properties > 100,
  'No theme.json properties indexed — run: node bin/wp-hooks.js quick-add theme-json',
);

// ==========================================================
// 1. Known global path resolves
// ==========================================================
test('1. settings.color.palette resolves with preset metadata', () => {
  const r = getThemeJsonProperty('settings.color.palette');
  assert(r.status === 'VALID', `Expected VALID, got ${r.status}`);
  assert(r.property.parent_context === 'settings', `Expected parent_context=settings, got ${r.property.parent_context}`);
  assert(r.property.preset_name === 'color', `Expected preset_name=color, got ${r.property.preset_name}`);
});

// ==========================================================
// 2. Styles path classified as preset_ref or css_color
// ==========================================================
test('2. styles.color.text is preset_ref:color', () => {
  const r = getThemeJsonProperty('styles.color.text');
  assert(r.status === 'VALID');
  assert(r.property.value_origin === 'preset_ref:color',
    `Expected preset_ref:color, got ${r.property.value_origin}`);
  assert(r.preset && r.preset.css_var_template === '--wp--preset--color--$slug',
    `Expected preset metadata with color CSS var, got ${JSON.stringify(r.preset)}`);
});

// ==========================================================
// 3. Per-block path resolution via normalisation
// ==========================================================
test('3. styles.blocks.core/paragraph.typography.fontSize resolves', () => {
  const { normalised, blockName } = normalisePath('styles.blocks.core/paragraph.typography.fontSize');
  assert(normalised === 'styles.blocks.{block-name}.typography.fontSize',
    `Expected placeholder path, got ${normalised}`);
  assert(blockName === 'core/paragraph', `Expected blockName=core/paragraph, got ${blockName}`);
  const r = getThemeJsonProperty(normalised);
  assert(r.status === 'VALID', `Expected VALID, got ${r.status}`);
  assert(r.property.scope === 'per-block', `Expected scope=per-block, got ${r.property.scope}`);
});

// ==========================================================
// 4. Per-element path resolution
// ==========================================================
test('4. styles.elements.button.color.text resolves', () => {
  const { normalised, elementName } = normalisePath('styles.elements.button.color.text');
  assert(normalised === 'styles.elements.{element-name}.color.text', `Expected placeholder, got ${normalised}`);
  assert(elementName === 'button');
  const r = getThemeJsonProperty(normalised);
  assert(r.status === 'VALID');
  assert(r.property.scope === 'per-element');
});

// ==========================================================
// 5. Hallucinated key returns NOT_FOUND with palette suggestion
// ==========================================================
test('5. "settings.colors" (the classic hallucination) returns NOT_FOUND with suggestions', () => {
  const r = getThemeJsonProperty('settings.colors');
  assert(r.status === 'NOT_FOUND', `Expected NOT_FOUND, got ${r.status}`);
  assert(r.similar.length > 0, 'Expected similar suggestions');
  const paths = r.similar.map(s => s.path);
  assert(
    paths.some(p => p.startsWith('settings.color')),
    `Expected a "settings.color*" suggestion, got: ${paths.join(', ')}`,
  );
});

// ==========================================================
// 6. Enum property carries enum_values
// ==========================================================
test('6. settings.spacing.spacingScale.unit exposes enum values', () => {
  const r = getThemeJsonProperty('settings.spacing.spacingScale.unit');
  assert(r.status === 'VALID');
  assert(r.property.value_origin === 'enum', `Expected enum, got ${r.property.value_origin}`);
  const enums = JSON.parse(r.property.enum_values);
  assert(enums.includes('px') && enums.includes('rem'),
    `Expected px and rem in enum, got: ${JSON.stringify(enums)}`);
});

// ==========================================================
// 7. Search returns ranked relevant results
// ==========================================================
test('7. search "font size" surfaces font-size paths', () => {
  const results = searchThemeJsonProperties('font size', { limit: 10 });
  assert(results.length > 0, 'Expected search results');
  assert(
    results.some(r => r.path.includes('fontSize') || r.path.includes('fontSizes')),
    `Expected a fontSize path in results, got: ${results.map(r => r.path).join(', ')}`,
  );
});

// ==========================================================
// 8. Context filter restricts to subtree
// ==========================================================
test('8. context=settings filter excludes styles paths', () => {
  const results = searchThemeJsonProperties('color', { context: 'settings', limit: 50 });
  assert(results.length > 0, 'Expected results');
  assert(results.every(r => r.parent_context.startsWith('settings')),
    `Expected all results in settings context, got contexts: ${[...new Set(results.map(r => r.parent_context))].join(', ')}`);
});

// ==========================================================
// 9. Indirect property alias is indexed
// ==========================================================
test('9. alias:gap exists and points at styles.spacing.blockGap', () => {
  const r = getThemeJsonProperty('alias:gap');
  assert(r.status === 'VALID', `Expected VALID for alias:gap, got ${r.status}`);
  assert(r.property.value_origin === 'alias', `Expected alias, got ${r.property.value_origin}`);
  assert(r.property.schema_ref === 'styles.spacing.blockGap',
    `Expected schema_ref=styles.spacing.blockGap, got ${r.property.schema_ref}`);
});

// ==========================================================
// 10. Confirmed-by both for paths in VALID_SETTINGS + schema
// ==========================================================
test('10. settings.color.palette is confirmed_by=both (schema AND class)', () => {
  const r = getThemeJsonProperty('settings.color.palette');
  assert(r.property.confirmed_by === 'both',
    `Expected confirmed_by=both, got ${r.property.confirmed_by}`);
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

closeDb();
process.exit(failed > 0 ? 1 : 0);
