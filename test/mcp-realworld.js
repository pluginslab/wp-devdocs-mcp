#!/usr/bin/env node

/**
 * MCP Real-World Effectiveness Test
 *
 * 5 realistic client requests that require Claude to figure out
 * which hooks to use and write actual plugin code. These are NOT
 * direct "what is the hook name" questions — they're practical
 * development tasks where hallucination is more likely.
 *
 * Requires: ANTHROPIC_API_KEY in .env
 * Requires: WooCommerce and Gutenberg sources indexed
 *
 * Run: node test/mcp-realworld.js
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  searchHooks,
  validateHook,
  getHookContext,
  searchBlockApis,
  closeDb,
} from '../src/db/sqlite.js';

const client = new Anthropic();
const MODEL = 'claude-sonnet-4-20250514';

// --- Tool definitions ---
const tools = [
  {
    name: 'search_hooks',
    description: 'Search WordPress hooks (actions/filters) across all indexed sources using full-text search.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        type: { type: 'string', enum: ['action', 'filter', 'action_ref_array', 'filter_ref_array', 'js_action', 'js_filter'] },
        source: { type: 'string' },
        is_dynamic: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'validate_hook',
    description: 'Check if a WordPress hook name is valid (exists in indexed sources). Returns VALID, NOT_FOUND, or REMOVED.',
    input_schema: {
      type: 'object',
      properties: {
        hook_name: { type: 'string', description: 'Exact hook name to validate' },
      },
      required: ['hook_name'],
    },
  },
  {
    name: 'get_hook_context',
    description: 'Get full surrounding code context for a specific WordPress hook by ID or name.',
    input_schema: {
      type: 'object',
      properties: {
        hook: { type: 'string', description: 'Hook ID or exact hook name' },
      },
      required: ['hook'],
    },
  },
  {
    name: 'search_block_apis',
    description: 'Search WordPress block registrations and JavaScript API usages.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
];

// --- Execute tool call against real DB ---
function executeTool(name, input) {
  switch (name) {
    case 'search_hooks': {
      const results = searchHooks(input.query, {
        type: input.type, source: input.source,
        isDynamic: input.is_dynamic, limit: input.limit || 10,
      });
      return JSON.stringify(results.map(r => ({
        name: r.name, type: r.type, source: r.source_name,
        file: `${r.file_path}:${r.line_number}`,
        params: r.params, description: r.inferred_description,
        docblock: r.docblock, is_dynamic: r.is_dynamic, id: r.id,
      })));
    }
    case 'validate_hook': {
      const result = validateHook(input.hook_name);
      if (result.status === 'VALID') {
        return JSON.stringify({
          status: 'VALID',
          locations: result.hooks.map(h => ({
            source: h.source_name, file: `${h.file_path}:${h.line_number}`, type: h.type,
            params: h.params,
          })),
        });
      }
      if (result.status === 'REMOVED') return JSON.stringify({ status: 'REMOVED' });
      return JSON.stringify({
        status: 'NOT_FOUND',
        similar: result.similar.map(s => ({ name: s.name, type: s.type })),
      });
    }
    case 'get_hook_context': {
      const hook = getHookContext(input.hook);
      if (!hook) return JSON.stringify({ error: 'Hook not found' });
      return JSON.stringify({
        name: hook.name, type: hook.type, file: `${hook.file_path}:${hook.line_number}`,
        params: hook.params, docblock: hook.docblock,
        code_before: hook.code_before, hook_line: hook.hook_line, code_after: hook.code_after,
        function_context: hook.function_context, class_name: hook.class_name,
      });
    }
    case 'search_block_apis': {
      const { blocks, apis } = searchBlockApis(input.query, { limit: input.limit || 10 });
      return JSON.stringify({
        blocks: blocks.map(b => ({
          block_name: b.block_name, title: b.block_title, category: b.block_category,
          file: `${b.file_path}:${b.line_number}`, source: b.source_name,
          code_context: b.code_context,
        })),
        apis: apis.map(a => ({
          api_call: a.api_call, namespace: a.namespace, method: a.method,
          file: `${a.file_path}:${a.line_number}`, source: a.source_name,
        })),
      });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// --- Send challenge to Claude ---
async function askClaude(challenge, useTools) {
  const messages = [{ role: 'user', content: challenge }];
  const systemPrompt = useTools
    ? 'You are a senior WordPress developer. Use the provided tools to look up and validate every hook name before writing code. Write a complete, working single-file WordPress plugin. Be precise with hook names, parameters, and callback signatures.'
    : 'You are a senior WordPress developer. Write a complete, working single-file WordPress plugin. Be precise with hook names, parameters, and callback signatures.';

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages,
    ...(useTools ? { tools } : {}),
  });

  let toolCallCount = 0;
  const toolsUsed = [];

  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        toolCallCount++;
        toolsUsed.push(`${block.name}(${JSON.stringify(block.input).slice(0, 60)}...)`);
        const result = executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: 'assistant', content: assistantContent });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: MODEL, max_tokens: 2048, system: systemPrompt,
      messages, tools,
    });
  }

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { text, toolCallCount, toolsUsed };
}

// --- Validate generated code against ground truth ---
function validateCode(code, checks) {
  const results = { correct: [], wrong: [], missing: [], hallucinated: [] };

  for (const hook of checks.requiredHooks || []) {
    if (code.includes(hook)) {
      results.correct.push(hook);
    } else {
      results.missing.push(hook);
    }
  }

  for (const hook of checks.wrongHooks || []) {
    if (code.includes(hook)) {
      results.hallucinated.push(hook);
    }
  }

  for (const pattern of checks.requiredPatterns || []) {
    if (!code.match(new RegExp(pattern))) {
      results.wrong.push(`Missing pattern: ${pattern}`);
    }
  }

  return results;
}

// ==========================================================
// 5 Real-World Challenges
// ==========================================================
const challenges = [
  {
    name: '1. WooCommerce: Gift message field on checkout',
    prompt: `A client wants customers to add a gift message during checkout. Write a single-file WordPress plugin that:
- Adds a "Gift Message" textarea field after the order notes on the checkout page
- Validates that the gift message is under 200 characters
- Saves the gift message to the order meta when the order is placed
- Displays the gift message in the admin order detail page

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [
        'woocommerce_after_order_notes',  // after the order notes section
        'woocommerce_checkout_process',
      ],
      wrongHooks: [
        'woocommerce_checkout_fields',  // common hallucination — this filter exists but it's for modifying field arrays, not rendering custom HTML
      ],
      requiredPatterns: [
        'add_action',
        'update_post_meta|update_meta',  // saving the meta
      ],
    },
  },
  {
    name: '2. WooCommerce: Custom column in admin orders list',
    prompt: `A client needs to see the payment method directly in the WooCommerce orders list table in wp-admin. Write a single-file WordPress plugin that:
- Adds a "Payment Method" column to the WooCommerce orders list table
- Shows the payment method title for each order in that column
- Positions the column after the "Total" column

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [
        'manage_edit-shop_order_columns',   // or manage_woocommerce_page_wc-orders_columns for HPOS
      ],
      wrongHooks: [
        'manage_shop_order_posts_columns',  // slightly wrong variation
      ],
      requiredPatterns: [
        'add_filter|add_action',
        'payment_method|get_payment_method',
      ],
    },
  },
  {
    name: '3. WooCommerce: Auto-complete virtual orders',
    prompt: `A client sells only virtual/downloadable products and wants orders to automatically complete after payment instead of staying in "processing" status. Write a single-file WordPress plugin that:
- Automatically sets the order status to "completed" when payment is complete, but ONLY if all items in the order are virtual or downloadable
- Does not affect orders with physical products
- Logs the auto-completion to the order notes

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [
        'woocommerce_payment_complete',     // or woocommerce_order_status_processing
      ],
      wrongHooks: [
        'woocommerce_order_status_completed',  // this fires AFTER completion, not for triggering it
      ],
      requiredPatterns: [
        'is_virtual|is_downloadable',
        'update_status.*completed',
      ],
    },
  },
  {
    name: '4. WooCommerce: Custom email content for specific product category',
    prompt: `A client sells wine and wants to add a legal disclaimer and shipping temperature warning to WooCommerce order confirmation emails, but ONLY when the order contains products from the "wine" category. Write a single-file WordPress plugin that:
- Checks if any product in the order belongs to the "wine" category
- If so, adds a warning block after the order details table in the email
- The warning should say "This order contains alcoholic beverages. Please ensure someone 21+ is available to receive the delivery. Temperature-sensitive: deliver within 2 business days."
- Should work for both HTML and plain text emails

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [
        'woocommerce_email_after_order_table',
      ],
      wrongHooks: [
        'woocommerce_email_order_details',     // common hallucination
        'woocommerce_email_after_order_details', // doesn't exist
      ],
      requiredPatterns: [
        'has_term|in_category|product_cat',
        'add_action',
      ],
    },
  },
  {
    name: '5. Gutenberg: CTA block with custom inspector controls',
    prompt: `A client wants a custom "Call to Action" Gutenberg block for their marketing pages. Write a single-file WordPress plugin that registers a dynamic block with:
- A text field for the CTA heading
- A text field for the CTA description
- A URL field for the button link
- A color picker in the Inspector Controls sidebar for the background color
- The block should render a styled div with heading, description, and a button

Use the WordPress block editor JavaScript APIs (wp.blocks, wp.blockEditor, wp.components, wp.element). Write the complete plugin PHP file that includes inline JavaScript for the block registration.

Important: Use the wp.blockEditor namespace (not wp.editor) for InspectorControls and other block editor components.`,
    checks: {
      requiredHooks: [],
      wrongHooks: [
        'wp.editor.InspectorControls',  // deprecated namespace
      ],
      requiredPatterns: [
        'wp\\.blockEditor\\.InspectorControls|wp\\.blockEditor[\\s\\S]{0,100}InspectorControls|blockEditor.*InspectorControls|InspectorControls.*=.*wp\\.blockEditor|\\{[^}]*InspectorControls[^}]*\\}\\s*=\\s*wp\\.blockEditor',
        'wp\\.blocks\\.registerBlockType|registerBlockType',
        'ColorP|ColorPalette|ColorPicker',
        'register_block_type',
      ],
    },
  },
];

// ==========================================================
// Main
// ==========================================================
async function main() {
  console.log('='.repeat(70));
  console.log('  MCP REAL-WORLD EFFECTIVENESS TEST');
  console.log('  Client plugin requests: WITHOUT vs WITH tool access');
  console.log('='.repeat(70));

  const summary = { without: { correct: 0, missing: 0, hallucinated: 0, patternFails: 0 },
                     with:    { correct: 0, missing: 0, hallucinated: 0, patternFails: 0 } };

  for (const c of challenges) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${c.name}`);
    console.log(`${'─'.repeat(70)}`);

    // WITHOUT tools
    console.log('\nAsking WITHOUT tools...');
    const rWithout = await askClaude(c.prompt, false);
    const vWithout = validateCode(rWithout.text, c.checks);

    console.log(`\n--- WITHOUT TOOLS ---`);
    // Print just the hook usage lines, not the full code
    const hooksFoundWithout = extractHookLines(rWithout.text);
    console.log(`Hooks used in code:`);
    for (const line of hooksFoundWithout) console.log(`  ${line}`);
    console.log(`\n  Correct hooks:    ${vWithout.correct.length > 0 ? vWithout.correct.join(', ') : 'none'}`);
    if (vWithout.missing.length) console.log(`  Missing hooks:    ${vWithout.missing.join(', ')}`);
    if (vWithout.hallucinated.length) console.log(`  Hallucinated:     ${vWithout.hallucinated.join(', ')}`);
    if (vWithout.wrong.length) console.log(`  Pattern issues:   ${vWithout.wrong.join(', ')}`);

    // WITH tools
    console.log('\nAsking WITH tools...');
    const rWith = await askClaude(c.prompt, true);
    const vWith = validateCode(rWith.text, c.checks);

    console.log(`\n--- WITH TOOLS (${rWith.toolCallCount} tool calls) ---`);
    const hooksFoundWith = extractHookLines(rWith.text);
    console.log(`Hooks used in code:`);
    for (const line of hooksFoundWith) console.log(`  ${line}`);
    console.log(`\n  Correct hooks:    ${vWith.correct.length > 0 ? vWith.correct.join(', ') : 'none'}`);
    if (vWith.missing.length) console.log(`  Missing hooks:    ${vWith.missing.join(', ')}`);
    if (vWith.hallucinated.length) console.log(`  Hallucinated:     ${vWith.hallucinated.join(', ')}`);
    if (vWith.wrong.length) console.log(`  Pattern issues:   ${vWith.wrong.join(', ')}`);

    if (rWith.toolsUsed.length > 0) {
      console.log(`\n  Tools called:`);
      for (const t of rWith.toolsUsed) console.log(`    ${t}`);
    }

    summary.without.correct += vWithout.correct.length;
    summary.without.missing += vWithout.missing.length;
    summary.without.hallucinated += vWithout.hallucinated.length;
    summary.without.patternFails += vWithout.wrong.length;
    summary.with.correct += vWith.correct.length;
    summary.with.missing += vWith.missing.length;
    summary.with.hallucinated += vWith.hallucinated.length;
    summary.with.patternFails += vWith.wrong.length;
  }

  // --- Summary ---
  const totalHooks = challenges.reduce((sum, c) => sum + (c.checks.requiredHooks || []).length, 0);
  const totalPatterns = challenges.reduce((sum, c) => sum + (c.checks.requiredPatterns || []).length, 0);

  console.log(`\n${'='.repeat(70)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(70)}`);
  console.log(`\n  Required hooks: ${totalHooks} | Required patterns: ${totalPatterns}\n`);
  console.log(`                  Hooks OK    Missing    Hallucinated    Patterns OK`);
  console.log(`  WITHOUT tools:  ${String(summary.without.correct).padEnd(12)}${String(summary.without.missing).padEnd(11)}${String(summary.without.hallucinated).padEnd(16)}${totalPatterns - summary.without.patternFails}/${totalPatterns}`);
  console.log(`  WITH tools:     ${String(summary.with.correct).padEnd(12)}${String(summary.with.missing).padEnd(11)}${String(summary.with.hallucinated).padEnd(16)}${totalPatterns - summary.with.patternFails}/${totalPatterns}`);

  const hookDiff = summary.with.correct - summary.without.correct;
  const hallDiff = summary.without.hallucinated - summary.with.hallucinated;
  console.log(`\n  Improvement:    ${hookDiff > 0 ? '+' : ''}${hookDiff} correct hooks, ${hallDiff > 0 ? '-' : '+'}${Math.abs(hallDiff)} hallucinations`);
  console.log('');
}

/** Extract lines containing add_action/add_filter/registerBlockType from code */
function extractHookLines(text) {
  const lines = text.split('\n');
  const hookLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/add_action\s*\(|add_filter\s*\(|registerBlockType\s*\(|InspectorControls|do_action\s*\(|apply_filters\s*\(/)) {
      hookLines.push(trimmed.slice(0, 120));
    }
  }
  // Deduplicate
  return [...new Set(hookLines)];
}

try {
  await main();
} catch (err) {
  console.error(`Fatal error: ${err.message}`);
  if (err.message.includes('API key')) {
    console.error('Make sure ANTHROPIC_API_KEY is set in .env');
  }
  process.exit(1);
} finally {
  closeDb();
}
