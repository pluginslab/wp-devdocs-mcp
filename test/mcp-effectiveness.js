#!/usr/bin/env node

/**
 * MCP Effectiveness Test
 *
 * Sends 5 WordPress development challenges to Claude via the Anthropic API:
 *   1. WITHOUT tools — Claude answers from training data (may hallucinate)
 *   2. WITH tools — Claude can call our indexed hook DB for verified answers
 *
 * Then compares both responses and validates the tool-assisted answer
 * against ground truth from our database.
 *
 * Requires: ANTHROPIC_API_KEY in .env
 * Requires: WooCommerce and Gutenberg sources indexed
 *
 * Run: node test/mcp-effectiveness.js
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

// --- Tool definitions matching our MCP tools ---
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

// --- Execute a tool call against our real DB ---
function executeTool(name, input) {
  switch (name) {
    case 'search_hooks': {
      const results = searchHooks(input.query, {
        type: input.type,
        source: input.source,
        isDynamic: input.is_dynamic,
        limit: input.limit || 10,
      });
      return JSON.stringify(results.map(r => ({
        name: r.name, type: r.type, source: r.source_name,
        file: `${r.file_path}:${r.line_number}`,
        params: r.params, description: r.inferred_description,
        is_dynamic: r.is_dynamic, id: r.id,
      })));
    }
    case 'validate_hook': {
      const result = validateHook(input.hook_name);
      if (result.status === 'VALID') {
        return JSON.stringify({
          status: 'VALID',
          locations: result.hooks.map(h => ({
            source: h.source_name, file: `${h.file_path}:${h.line_number}`, type: h.type,
          })),
        });
      }
      if (result.status === 'REMOVED') {
        return JSON.stringify({ status: 'REMOVED' });
      }
      return JSON.stringify({
        status: 'NOT_FOUND',
        similar: result.similar.map(s => s.name),
      });
    }
    case 'get_hook_context': {
      const hook = getHookContext(input.hook);
      if (!hook) return JSON.stringify({ error: 'Hook not found' });
      return JSON.stringify({
        name: hook.name, type: hook.type, file: `${hook.file_path}:${hook.line_number}`,
        params: hook.params, docblock: hook.docblock,
        code_before: hook.code_before, hook_line: hook.hook_line, code_after: hook.code_after,
      });
    }
    case 'search_block_apis': {
      const { blocks, apis } = searchBlockApis(input.query, { limit: input.limit || 10 });
      return JSON.stringify({
        blocks: blocks.map(b => ({
          block_name: b.block_name, title: b.block_title, category: b.block_category,
          file: `${b.file_path}:${b.line_number}`, source: b.source_name,
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

// --- Send a challenge to Claude, optionally with tools ---
async function askClaude(challenge, useTools) {
  const messages = [{ role: 'user', content: challenge }];
  const systemPrompt = useTools
    ? 'You are a WordPress development assistant. Use the provided tools to look up real hook names and APIs before answering. Always validate hook names. Be concise — list the exact hook names, their types, file locations, and parameters.'
    : 'You are a WordPress development assistant. Answer based on your training knowledge. Be concise — list the exact hook names, their types, file locations, and parameters.';

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    ...(useTools ? { tools } : {}),
  });

  // Agentic tool loop — keep going while Claude wants to call tools
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        const result = executeTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: 'assistant', content: assistantContent });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    });
  }

  // Extract final text
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// --- Ground truth validation using our DB ---
function validateAnswer(answer, groundTruth) {
  const found = [];
  const missing = [];
  for (const hookName of groundTruth.mustContain) {
    if (answer.includes(hookName)) {
      found.push(hookName);
    } else {
      missing.push(hookName);
    }
  }
  const hallucinations = [];
  if (groundTruth.mustNotContain) {
    for (const bad of groundTruth.mustNotContain) {
      if (answer.includes(bad)) {
        hallucinations.push(bad);
      }
    }
  }
  return { found, missing, hallucinations };
}

// ==========================================================
// 5 Challenges
// ==========================================================
const challenges = [
  {
    name: 'WooCommerce checkout hooks',
    prompt: 'What are the exact WooCommerce action hook names that fire on the checkout page, specifically before and after the billing form? Give me the precise hook names I can use with add_action().',
    groundTruth: {
      mustContain: ['woocommerce_before_checkout_billing_form', 'woocommerce_after_checkout_billing_form'],
    },
  },
  {
    name: 'WooCommerce order item meta hooks',
    prompt: 'What is the exact hook name for adding custom meta data display before order item meta in WooCommerce admin? I need the precise action hook name and its parameters.',
    groundTruth: {
      mustContain: ['woocommerce_before_order_itemmeta'],
    },
  },
  {
    name: 'WooCommerce cart filters',
    prompt: 'What is the exact WooCommerce filter hook name for modifying the "add to cart" button text on single product pages? Give me the precise hook name.',
    groundTruth: {
      mustContain: ['woocommerce_product_single_add_to_cart_text'],
    },
  },
  {
    name: 'WooCommerce email hooks',
    prompt: 'What are the exact WooCommerce action hooks that fire before and after the email order details table? Give me the precise hook names I can use.',
    groundTruth: {
      mustContain: ['woocommerce_email_before_order_table', 'woocommerce_email_after_order_table'],
    },
  },
  {
    name: 'InspectorControls import path',
    prompt: 'In the WordPress Gutenberg codebase, what is the correct JavaScript namespace path for InspectorControls when accessed via the wp global? (e.g. wp.something.InspectorControls)',
    groundTruth: {
      mustContain: ['wp.blockEditor.InspectorControls'],
      mustNotContain: ['wp.editor.InspectorControls'],
    },
  },
];

// ==========================================================
// Main
// ==========================================================
async function main() {
  console.log('='.repeat(70));
  console.log('  MCP EFFECTIVENESS TEST');
  console.log('  Comparing Claude responses WITHOUT vs WITH tool access');
  console.log('='.repeat(70));

  let totalWithout = { found: 0, missing: 0, hallucinations: 0 };
  let totalWith = { found: 0, missing: 0, hallucinations: 0 };

  for (let i = 0; i < challenges.length; i++) {
    const c = challenges[i];
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Challenge ${i + 1}: ${c.name}`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`Q: ${c.prompt}\n`);

    // WITHOUT tools
    console.log('Asking WITHOUT tools...');
    const answerWithout = await askClaude(c.prompt, false);
    const vWithout = validateAnswer(answerWithout, c.groundTruth);

    console.log(`\n--- WITHOUT TOOLS ---`);
    console.log(answerWithout);
    console.log(`\n  Correct hooks found:  ${vWithout.found.length}/${c.groundTruth.mustContain.length} ${vWithout.found.length > 0 ? '(' + vWithout.found.join(', ') + ')' : ''}`);
    if (vWithout.missing.length) console.log(`  Missing:              ${vWithout.missing.join(', ')}`);
    if (vWithout.hallucinations.length) console.log(`  Hallucinations:       ${vWithout.hallucinations.join(', ')}`);

    // WITH tools
    console.log('\nAsking WITH tools...');
    const answerWith = await askClaude(c.prompt, true);
    const vWith = validateAnswer(answerWith, c.groundTruth);

    console.log(`\n--- WITH TOOLS ---`);
    console.log(answerWith);
    console.log(`\n  Correct hooks found:  ${vWith.found.length}/${c.groundTruth.mustContain.length} ${vWith.found.length > 0 ? '(' + vWith.found.join(', ') + ')' : ''}`);
    if (vWith.missing.length) console.log(`  Missing:              ${vWith.missing.join(', ')}`);
    if (vWith.hallucinations.length) console.log(`  Hallucinations:       ${vWith.hallucinations.join(', ')}`);

    totalWithout.found += vWithout.found.length;
    totalWithout.missing += vWithout.missing.length;
    totalWithout.hallucinations += vWithout.hallucinations.length;
    totalWith.found += vWith.found.length;
    totalWith.missing += vWith.missing.length;
    totalWith.hallucinations += vWith.hallucinations.length;
  }

  // --- Summary ---
  const totalExpected = challenges.reduce((sum, c) => sum + c.groundTruth.mustContain.length, 0);
  console.log(`\n${'='.repeat(70)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(70)}`);
  console.log(`\n  Total expected hooks across all challenges: ${totalExpected}\n`);
  console.log(`  WITHOUT tools:  ${totalWithout.found}/${totalExpected} correct, ${totalWithout.missing} missing, ${totalWithout.hallucinations} hallucinations`);
  console.log(`  WITH tools:     ${totalWith.found}/${totalExpected} correct, ${totalWith.missing} missing, ${totalWith.hallucinations} hallucinations`);
  console.log(`\n  Improvement:    ${totalWith.found - totalWithout.found > 0 ? '+' : ''}${totalWith.found - totalWithout.found} correct hooks, ${totalWithout.hallucinations - totalWith.hallucinations > 0 ? '-' : ''}${totalWithout.hallucinations - totalWith.hallucinations} hallucinations`);
  console.log('');
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
