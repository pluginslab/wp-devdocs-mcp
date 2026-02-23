#!/usr/bin/env node

/**
 * MCP Real-World HARD Effectiveness Test — GEMINI edition
 *
 * Same 5 challenging client requests as mcp-realworld-hard.js,
 * but using Gemini 3.1 Pro Preview instead of Claude Sonnet 4.
 *
 * Requires: GEMINI_API_KEY in .env
 * Requires: WooCommerce and Gutenberg sources indexed
 *
 * Run: node test/mcp-realworld-gemini.js
 */

import 'dotenv/config';
import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai';
import {
  searchHooks,
  validateHook,
  getHookContext,
  searchBlockApis,
  closeDb,
} from '../src/db/sqlite.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODEL = 'gemini-3.1-pro-preview';

// --- Tool declarations in Gemini format ---
const toolDeclarations = [
  {
    name: 'search_hooks',
    description: 'Search WordPress hooks (actions/filters) across all indexed sources using full-text search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        type: { type: 'string', enum: ['action', 'filter', 'action_ref_array', 'filter_ref_array', 'js_action', 'js_filter'], description: 'Filter by hook type' },
        source: { type: 'string', description: 'Filter by source name' },
        is_dynamic: { type: 'boolean', description: 'Filter for dynamic hooks' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
  },
  {
    name: 'validate_hook',
    description: 'Check if a WordPress hook name is valid (exists in indexed sources). Returns VALID, NOT_FOUND, or REMOVED.',
    parameters: {
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
    parameters: {
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
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
  },
];

// --- Execute tool call against real DB ---
function executeTool(name, args) {
  switch (name) {
    case 'search_hooks': {
      const results = searchHooks(args.query, {
        type: args.type, source: args.source,
        isDynamic: args.is_dynamic, limit: args.limit || 10,
      });
      return JSON.stringify(results.map(r => ({
        name: r.name, type: r.type, source: r.source_name,
        file: `${r.file_path}:${r.line_number}`,
        params: r.params, description: r.inferred_description,
        docblock: r.docblock, is_dynamic: r.is_dynamic, id: r.id,
        class_name: r.class_name, function_context: r.function_context,
      })));
    }
    case 'validate_hook': {
      const result = validateHook(args.hook_name);
      if (result.status === 'VALID') {
        return JSON.stringify({
          status: 'VALID',
          locations: result.hooks.map(h => ({
            source: h.source_name, file: `${h.file_path}:${h.line_number}`,
            type: h.type, params: h.params,
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
      const hook = getHookContext(args.hook);
      if (!hook) return JSON.stringify({ error: 'Hook not found' });
      return JSON.stringify({
        name: hook.name, type: hook.type, file: `${hook.file_path}:${hook.line_number}`,
        params: hook.params, docblock: hook.docblock,
        code_before: hook.code_before, hook_line: hook.hook_line, code_after: hook.code_after,
        function_context: hook.function_context, class_name: hook.class_name,
      });
    }
    case 'search_block_apis': {
      const { blocks, apis } = searchBlockApis(args.query, { limit: args.limit || 10 });
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

// --- Send challenge to Gemini ---
async function askGemini(challenge, useTools) {
  const systemInstruction = useTools
    ? 'You are a senior WordPress developer. Use the provided tools to look up and validate every hook name before writing code. Do NOT guess hook names — search and validate them first. Write a complete, working single-file WordPress plugin. Be precise with hook names, parameters, and callback signatures.'
    : 'You are a senior WordPress developer. Write a complete, working single-file WordPress plugin. Be precise with hook names, parameters, and callback signatures.';

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction,
    ...(useTools ? { tools: [{ functionDeclarations: toolDeclarations }] } : {}),
  });

  const chat = model.startChat();
  let response = await chat.sendMessage(challenge);
  let toolCallCount = 0;
  const toolsUsed = [];

  // Agentic tool loop
  while (true) {
    const candidate = response.response.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length === 0) break;

    // Execute all function calls and send responses
    const functionResponses = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      toolCallCount++;
      toolsUsed.push(`${name}(${JSON.stringify(args).slice(0, 80)})`);
      const result = executeTool(name, args);
      functionResponses.push({
        functionResponse: {
          name,
          response: { result },
        },
      });
    }

    response = await chat.sendMessage(functionResponses);
  }

  // Extract final text
  const text = response.response.text();
  return { text, toolCallCount, toolsUsed };
}

// --- Validation ---
function validateCode(code, checks) {
  const results = { correct: [], missing: [], hallucinated: [], patternOk: [], patternFail: [] };

  for (const hook of checks.requiredHooks || []) {
    if (code.includes(hook)) results.correct.push(hook);
    else results.missing.push(hook);
  }

  for (const alt of checks.acceptAlternatives || []) {
    const found = alt.hooks.find(h => code.includes(h));
    if (found) results.correct.push(`${alt.label}: ${found}`);
    else results.missing.push(`${alt.label}: none of [${alt.hooks.join(', ')}]`);
  }

  for (const hook of checks.wrongHooks || []) {
    if (code.includes(hook)) results.hallucinated.push(hook);
  }

  for (const p of checks.requiredPatterns || []) {
    if (code.match(new RegExp(p, 's'))) results.patternOk.push(p.slice(0, 50));
    else results.patternFail.push(p.slice(0, 50));
  }

  return results;
}

function extractHookLines(text) {
  const lines = text.split('\n');
  const hookLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/add_action\s*\(|add_filter\s*\(|registerBlockType|InspectorControls|do_action\s*\(|apply_filters\s*\(|BlockControls|useSelect|useDispatch|registerPlugin|PluginSidebar|PluginDocumentSettingPanel|SlotFill/)) {
      hookLines.push(trimmed.slice(0, 130));
    }
  }
  return [...new Set(hookLines)];
}

// ==========================================================
// Same 5 HARD challenges
// ==========================================================
const challenges = [
  {
    name: '1. WooCommerce HPOS: Custom filter dropdown on orders list',
    prompt: `A client using WooCommerce with HPOS (High-Performance Order Storage) enabled needs a custom dropdown filter on the orders list page in wp-admin to filter orders by a custom meta field called "_delivery_type" (values: "standard", "express", "same-day").

Write a single-file WordPress plugin that:
- Adds a dropdown filter to the HPOS orders list table (not the legacy post-type table)
- Filters orders based on the selected delivery type using the correct HPOS query mechanism
- Works specifically with the new WooCommerce orders table, not WP_Query

Important: WooCommerce HPOS uses its own ListTable class, not WP_List_Table. Use the correct HPOS-specific hooks — do not use manage_edit-shop_order_columns or other legacy post-type hooks for the filter dropdown.

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [],
      acceptAlternatives: [
        {
          label: 'HPOS orders list table nav/filter hook',
          hooks: [
            'woocommerce_order_list_table_restrict_manage_orders',
            'woocommerce_order_list_table_extra_tablenav',
            'restrict_manage_posts',
          ],
        },
        {
          label: 'HPOS query args filter',
          hooks: [
            'woocommerce_order_list_table_prepare_items_query_args',
            'woocommerce_order_query_args',
            'woocommerce_shop_order_list_table_prepare_items_query_args',
          ],
        },
      ],
      wrongHooks: [
        'manage_edit-shop_order_columns',
        'posts_clauses',
        'pre_get_posts',
      ],
      requiredPatterns: [
        '_delivery_type',
      ],
    },
  },
  {
    name: '2. WooCommerce: Dynamic thank-you page per payment gateway',
    prompt: `A client has multiple payment gateways (PayPal, Stripe, bank transfer) and wants completely different thank-you page content for each gateway. For example:
- PayPal: show a message about PayPal buyer protection
- Stripe: show a message about instant processing
- Bank transfer (bacs): show bank details and processing time warning

Write a single-file WordPress plugin that hooks into the WooCommerce thank-you page and renders different content sections based on the payment method used. The plugin should use the gateway-specific dynamic hook that WooCommerce provides (not just check the payment method in a single generic hook).

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [],
      acceptAlternatives: [
        {
          label: 'Dynamic thankyou hook per gateway',
          hooks: [
            'woocommerce_thankyou_paypal',
            'woocommerce_thankyou_stripe',
            'woocommerce_thankyou_bacs',
          ],
        },
      ],
      wrongHooks: [
        'woocommerce_order_details_after_order_table',
        'woocommerce_after_order_details',
      ],
      requiredPatterns: [
        'woocommerce_thankyou_',
        'paypal|PayPal',
        'bacs|bank.transfer',
      ],
    },
  },
  {
    name: '3. WooCommerce: Custom product tab with saved meta',
    prompt: `A client sells handmade furniture and wants to add a "Care Instructions" tab to the WooCommerce product editor in wp-admin (the product data metabox, NOT the frontend product page tabs). The tab should:
- Appear as a new tab in the product data metabox alongside General, Inventory, Shipping, etc.
- Contain a textarea for care instructions and a select field for "material type" (wood, metal, fabric, leather)
- Save both fields as product meta when the product is saved
- Display the care instructions on the frontend single product page in a custom product tab

This requires TWO separate things: a backend product data tab in wp-admin AND a frontend product page tab. Use the correct hooks for each.

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [
        'woocommerce_product_data_tabs',
        'woocommerce_product_data_panels',
        'woocommerce_process_product_meta',
        'woocommerce_product_tabs',
      ],
      wrongHooks: [
        'woocommerce_product_options_general_product_data',
        'woocommerce_product_write_panels',
        'woocommerce_product_write_panel_tabs',
        'save_post_product',
      ],
      requiredPatterns: [
        'wc_get_product|get_post_meta|get_meta',
        'update_post_meta|update_meta',
      ],
    },
  },
  {
    name: '4. WooCommerce: Cart item custom data with price modifier',
    prompt: `A client sells customisable products (e.g. engraved jewelry). Write a single-file WordPress plugin that:
- Adds a text input field "Engraving Text" on the single product page above the add-to-cart button
- When added to cart, stores the engraving text as custom cart item data
- Adds a $5 surcharge to the item price when engraving text is provided
- Displays the engraving text in the cart and checkout order review table under the product name
- Saves the engraving text to order item meta so it appears in admin and emails

You need to use the correct WooCommerce hooks for:
1. Adding the field to the product page (before add to cart)
2. Capturing the field value when adding to cart
3. Storing custom data in the cart item
4. Modifying the cart item price
5. Displaying the custom data in cart/checkout
6. Saving to order item meta

Write the complete plugin PHP file.`,
    checks: {
      requiredHooks: [
        'woocommerce_before_add_to_cart_button',
      ],
      acceptAlternatives: [
        {
          label: 'Add to cart data capture',
          hooks: [
            'woocommerce_add_cart_item_data',
            'woocommerce_add_to_cart_validation',
          ],
        },
        {
          label: 'Cart item display',
          hooks: [
            'woocommerce_get_item_data',
            'woocommerce_cart_item_name',
          ],
        },
        {
          label: 'Price modification',
          hooks: [
            'woocommerce_before_calculate_totals',
            'woocommerce_cart_item_price',
            'woocommerce_product_get_price',
          ],
        },
        {
          label: 'Order item meta save',
          hooks: [
            'woocommerce_checkout_create_order_line_item',
            'woocommerce_add_order_item_meta',
            'woocommerce_new_order_item',
          ],
        },
      ],
      wrongHooks: [
        'woocommerce_cart_calculate_fees',
      ],
      requiredPatterns: [
        'engraving|engrav',
        '5|surcharge|extra',
      ],
    },
  },
  {
    name: '5. Gutenberg: Custom sidebar plugin with document settings panel',
    prompt: `A client wants a custom sidebar panel in the Gutenberg block editor that appears in the document settings sidebar (not as a separate sidebar). The panel should:
- Show a "SEO Settings" section in the post document sidebar (alongside Status, Categories, etc.)
- Have a text input for "Meta Description" (max 160 chars with a live character counter)
- Have a text input for "Focus Keyword"
- Save both fields as post meta
- Use the wp.plugins and wp.editPost JavaScript namespaces to register the plugin and panel
- Use wp.data (useSelect/useDispatch) to read and write the post meta

Do NOT create a new sidebar icon — use PluginDocumentSettingPanel to inject into the existing document sidebar.

Write the complete plugin PHP file with inline JavaScript.`,
    checks: {
      requiredHooks: [],
      requiredPatterns: [
        'PluginDocumentSettingPanel',
        'registerPlugin|wp\\.plugins\\.registerPlugin',
        'useSelect|useDispatch|wp\\.data',
        'register_post_meta|register_meta',
        'meta_description|meta-description',
        'focus_keyword|focus-keyword',
      ],
      wrongHooks: [
        'PluginSidebar',
        'wp.editor.PluginSidebar',
      ],
    },
  },
];

// ==========================================================
// Main
// ==========================================================
async function main() {
  console.log('='.repeat(70));
  console.log(`  MCP REAL-WORLD HARD TEST — GEMINI (${MODEL})`);
  console.log('  Comparing WITHOUT vs WITH tool access');
  console.log('='.repeat(70));

  const summary = {
    without: { correct: 0, missing: 0, hallucinated: 0, patternOk: 0, patternFail: 0 },
    with:    { correct: 0, missing: 0, hallucinated: 0, patternOk: 0, patternFail: 0 },
  };

  for (const c of challenges) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${c.name}`);
    console.log(`${'─'.repeat(70)}`);

    // WITHOUT tools
    console.log('\nAsking WITHOUT tools...');
    let rWithout;
    try {
      rWithout = await askGemini(c.prompt, false);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      rWithout = { text: '', toolCallCount: 0, toolsUsed: [] };
    }
    const vWithout = validateCode(rWithout.text, c.checks);

    console.log(`\n--- WITHOUT TOOLS ---`);
    const hooksWithout = extractHookLines(rWithout.text);
    console.log(`Hooks/APIs used:`);
    for (const line of hooksWithout) console.log(`  ${line}`);
    printValidation(vWithout);

    // WITH tools
    console.log('\nAsking WITH tools...');
    let rWith;
    try {
      rWith = await askGemini(c.prompt, true);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      rWith = { text: '', toolCallCount: 0, toolsUsed: [] };
    }
    const vWith = validateCode(rWith.text, c.checks);

    console.log(`\n--- WITH TOOLS (${rWith.toolCallCount} tool calls) ---`);
    const hooksWith = extractHookLines(rWith.text);
    console.log(`Hooks/APIs used:`);
    for (const line of hooksWith) console.log(`  ${line}`);
    printValidation(vWith);

    if (rWith.toolsUsed.length > 0) {
      console.log(`\n  Tool calls:`);
      for (const t of rWith.toolsUsed) console.log(`    ${t}`);
    }

    summary.without.correct += vWithout.correct.length;
    summary.without.missing += vWithout.missing.length;
    summary.without.hallucinated += vWithout.hallucinated.length;
    summary.without.patternOk += vWithout.patternOk.length;
    summary.without.patternFail += vWithout.patternFail.length;
    summary.with.correct += vWith.correct.length;
    summary.with.missing += vWith.missing.length;
    summary.with.hallucinated += vWith.hallucinated.length;
    summary.with.patternOk += vWith.patternOk.length;
    summary.with.patternFail += vWith.patternFail.length;
  }

  // --- Summary ---
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  SUMMARY — ${MODEL}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`\n                  Hooks OK    Missing    Hallucinated    Patterns`);
  console.log(`  WITHOUT tools:  ${String(summary.without.correct).padEnd(12)}${String(summary.without.missing).padEnd(11)}${String(summary.without.hallucinated).padEnd(16)}${summary.without.patternOk}/${summary.without.patternOk + summary.without.patternFail}`);
  console.log(`  WITH tools:     ${String(summary.with.correct).padEnd(12)}${String(summary.with.missing).padEnd(11)}${String(summary.with.hallucinated).padEnd(16)}${summary.with.patternOk}/${summary.with.patternOk + summary.with.patternFail}`);

  const hookDiff = summary.with.correct - summary.without.correct;
  const hallDiff = summary.without.hallucinated - summary.with.hallucinated;
  console.log(`\n  Delta:          ${hookDiff > 0 ? '+' : ''}${hookDiff} correct, ${hallDiff > 0 ? '-' : '+'}${Math.abs(hallDiff)} hallucinations`);
  console.log('');
}

function printValidation(v) {
  if (v.correct.length) console.log(`\n  Correct:        ${v.correct.join(', ')}`);
  if (v.missing.length) console.log(`  Missing:        ${v.missing.join(', ')}`);
  if (v.hallucinated.length) console.log(`  HALLUCINATED:   ${v.hallucinated.join(', ')}`);
  if (v.patternOk.length) console.log(`  Patterns OK:    ${v.patternOk.join(', ')}`);
  if (v.patternFail.length) console.log(`  Patterns FAIL:  ${v.patternFail.join(', ')}`);
}

try {
  await main();
} catch (err) {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
} finally {
  closeDb();
}
