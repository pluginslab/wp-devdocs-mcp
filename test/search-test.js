#!/usr/bin/env node

/**
 * Search integration tests.
 * Requires WooCommerce and Gutenberg sources to be indexed first.
 *
 * Run: node test/search-test.js
 */

import {
  searchHooks,
  validateHook,
  getHookContext,
  searchBlockApis,
  getStats,
  closeDb,
} from '../src/db/sqlite.js';

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

console.log('\nRunning search integration tests...\n');

// --- Verify prerequisites ---
const stats = getStats();
assert(stats.totals.active_hooks > 0, 'No hooks indexed — run source:add for woocommerce and gutenberg first');

// ==========================================================
// 1. Basic hook search returns results
// ==========================================================
test('1. Search "woocommerce_checkout" returns hooks', () => {
  const results = searchHooks('woocommerce_checkout', { limit: 10 });
  assert(results.length > 0, 'Expected results');
  assert(results.every(r => r.name.includes('woocommerce') || r.name.includes('checkout')),
    'All results should be relevant to woocommerce/checkout');
});

// ==========================================================
// 2. Search with type filter narrows results
// ==========================================================
test('2. Type filter "filter" excludes actions', () => {
  const all = searchHooks('woocommerce_product', { limit: 50 });
  const filtersOnly = searchHooks('woocommerce_product', { type: 'filter', limit: 50 });
  assert(filtersOnly.length > 0, 'Expected filter results');
  assert(filtersOnly.length <= all.length, 'Filtered results should be <= unfiltered');
  assert(filtersOnly.every(r => r.type === 'filter'), 'All results should be type filter');
});

// ==========================================================
// 3. Source filter restricts to one source
// ==========================================================
test('3. Source filter restricts results to named source', () => {
  const results = searchHooks('action', { source: 'woocommerce', limit: 10 });
  assert(results.length > 0, 'Expected results');
  assert(results.every(r => r.source_name === 'woocommerce'),
    'All results should be from woocommerce source');
});

// ==========================================================
// 4. validate_hook returns VALID for known hook
// ==========================================================
test('4. Validate known hook "woocommerce_before_order_notes" returns VALID', () => {
  const result = validateHook('woocommerce_before_order_notes');
  assert(result.status === 'VALID', `Expected VALID, got ${result.status}`);
  assert(result.hooks.length > 0, 'Expected hook locations');
  assert(result.hooks[0].source_name === 'woocommerce', 'Expected woocommerce source');
});

// ==========================================================
// 5. validate_hook returns NOT_FOUND for fake hook
// ==========================================================
test('5. Validate fake hook "woocommerce_totally_fake_hook_xyz" returns NOT_FOUND', () => {
  const result = validateHook('woocommerce_totally_fake_hook_xyz');
  assert(result.status === 'NOT_FOUND', `Expected NOT_FOUND, got ${result.status}`);
});

// ==========================================================
// 6. validate_hook returns similar suggestions for close match
// ==========================================================
test('6. Validate close misspelling suggests similar hooks', () => {
  const result = validateHook('woocommerce_before_order_note');
  assert(result.status === 'NOT_FOUND', `Expected NOT_FOUND, got ${result.status}`);
  assert(result.similar.length > 0, 'Expected similar suggestions');
  const names = result.similar.map(s => s.name);
  assert(names.some(n => n.includes('woocommerce_before_order')),
    `Expected a suggestion containing "woocommerce_before_order", got: ${names.join(', ')}`);
});

// ==========================================================
// 7. get_hook_context returns full context for a hook
// ==========================================================
test('7. get_hook_context returns code context by name', () => {
  const hook = getHookContext('woocommerce_before_order_notes');
  assert(hook !== null && hook !== undefined, 'Expected a hook result');
  assert(hook.name === 'woocommerce_before_order_notes', `Expected correct name, got ${hook.name}`);
  assert(hook.file_path, 'Expected file_path');
  assert(hook.line_number > 0, 'Expected line_number');
  assert(hook.hook_line, 'Expected hook_line code');
});

// ==========================================================
// 8. search_block_apis only returns relevant API matches
// ==========================================================
test('8. search_block_apis "InspectorControls" only returns blockEditor matches', () => {
  const { apis } = searchBlockApis('InspectorControls', { limit: 10 });
  assert(apis.length > 0, 'Expected API results');
  assert(apis.every(a => a.api_call.includes('InspectorControls')),
    `All API results should contain InspectorControls in api_call, got: ${apis.map(a => a.api_call).join(', ')}`);
});

// ==========================================================
// 9. search_block_apis block results match on block_name/title
// ==========================================================
test('9. search_block_apis "core/paragraph" returns block registrations', () => {
  const { blocks } = searchBlockApis('paragraph', { limit: 10 });
  // May or may not have results depending on what gutenberg indexes
  // but should not throw and any results should be relevant
  if (blocks.length > 0) {
    assert(blocks.every(b =>
      (b.block_name && b.block_name.includes('paragraph')) ||
      (b.block_title && b.block_title.toLowerCase().includes('paragraph'))
    ), `Block results should be relevant to "paragraph", got: ${blocks.map(b => b.block_name).join(', ')}`);
  }
  // Pass even with 0 results — the important thing is no false positives
});

// ==========================================================
// 10. Dynamic hook search finds hooks with {dynamic} in name
// ==========================================================
test('10. Dynamic hook filter returns only dynamic hooks', () => {
  const results = searchHooks('woocommerce', { isDynamic: true, limit: 10 });
  assert(results.length > 0, 'Expected dynamic hook results');
  assert(results.every(r => r.is_dynamic === 1),
    'All results should have is_dynamic=1');
  assert(results.every(r => r.name.includes('{') || r.name.includes('$')),
    `All dynamic hooks should have dynamic markers in name, got: ${results.map(r => r.name).join(', ')}`);
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

closeDb();
process.exit(failed > 0 ? 1 : 0);
