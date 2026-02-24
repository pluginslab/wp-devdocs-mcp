import { z } from 'zod';
import { searchHooks } from '../../db/sqlite.js';

export const searchHooksSchema = {
  name: 'search_hooks',
  description: 'Search WordPress hooks (actions/filters) across all indexed sources using full-text search. Returns BM25-ranked results with file locations, parameters, and descriptions.',
  inputSchema: {
    query: z.string().describe('Search query — hook name, keyword, or description fragment'),
    type: z.enum(['action', 'filter', 'action_ref_array', 'filter_ref_array', 'js_action', 'js_filter']).optional().describe('Filter by hook type'),
    source: z.string().optional().describe('Filter by source name'),
    is_dynamic: z.boolean().optional().describe('Filter for dynamic hook names only'),
    include_removed: z.boolean().optional().describe('Include soft-deleted hooks'),
    limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
  },
};

/**
 * MCP tool handler — search WordPress hooks using full-text search.
 * @param {object} args - { query, type?, source?, is_dynamic?, include_removed?, limit? }
 * @returns {{ content: Array<{ type: string, text: string }>, isError?: boolean }}
 */
export function handleSearchHooks(args) {
  try {
    const results = searchHooks(args.query, {
      type: args.type,
      source: args.source,
      isDynamic: args.is_dynamic,
      includeRemoved: args.include_removed,
      limit: args.limit || 20,
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No hooks found matching "${args.query}". Try broader search terms or check source indexing with the CLI.` }],
      };
    }

    const formatted = results.map((h, i) => {
      const lines = [
        `### ${i + 1}. ${h.name}`,
        `- **Type:** ${h.type} | **Source:** ${h.source_name}`,
        `- **File:** ${h.file_path}:${h.line_number}`,
      ];
      if (h.is_dynamic) lines.push('- **Dynamic:** yes');
      if (h.status === 'removed') lines.push('- **Status:** REMOVED');
      if (h.php_function) lines.push(`- **Function:** ${h.php_function}()`);
      if (h.class_name) lines.push(`- **Class:** ${h.class_name}`);
      if (h.params) lines.push(`- **Params:** ${h.params}`);
      if (h.inferred_description) lines.push(`- **Description:** ${h.inferred_description}`);
      if (h.docblock) lines.push(`- **Docblock:** ${h.docblock.slice(0, 200)}${h.docblock.length > 200 ? '...' : ''}`);
      lines.push(`- **ID:** ${h.id}`);
      return lines.join('\n');
    }).join('\n\n');

    return {
      content: [{ type: 'text', text: `Found ${results.length} hook(s) matching "${args.query}":\n\n${formatted}` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error searching hooks: ${err.message}` }],
      isError: true,
    };
  }
}
