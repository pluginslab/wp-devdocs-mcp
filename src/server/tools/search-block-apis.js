import { z } from 'zod';
import { searchBlockApis } from '../../db/sqlite.js';

export const searchBlockApisSchema = {
  name: 'search_block_apis',
  description: 'Search WordPress block registrations and JavaScript API usages (wp.blocks.*, wp.editor.*, wp.blockEditor.*, etc.) across all indexed sources.',
  inputSchema: {
    query: z.string().describe('Search query — block name, API call, namespace, or keyword'),
    limit: z.number().min(1).max(100).optional().describe('Max results per category (default 20)'),
  },
};

/**
 * MCP tool handler — search block registrations and WP JS API usages.
 * @param {object} args - { query, limit? }
 * @returns {{ content: Array<{ type: string, text: string }>, isError?: boolean }}
 */
export function handleSearchBlockApis(args) {
  try {
    const { blocks, apis } = searchBlockApis(args.query, { limit: args.limit || 20 });

    if (blocks.length === 0 && apis.length === 0) {
      return {
        content: [{ type: 'text', text: `No block registrations or API usages found matching "${args.query}".` }],
      };
    }

    const sections = [];

    if (blocks.length > 0) {
      const blockLines = blocks.map((b, i) => {
        const lines = [
          `### ${i + 1}. ${b.block_name || 'unknown'}`,
          `- **Source:** ${b.source_name} | **File:** ${b.file_path}:${b.line_number}`,
        ];
        if (b.block_title) lines.push(`- **Title:** ${b.block_title}`);
        if (b.block_category) lines.push(`- **Category:** ${b.block_category}`);
        if (b.code_context) {
          lines.push(`- **Context:**\n\`\`\`js\n${b.code_context.slice(0, 500)}\n\`\`\``);
        }
        return lines.join('\n');
      }).join('\n\n');

      sections.push(`## Block Registrations (${blocks.length})\n\n${blockLines}`);
    }

    if (apis.length > 0) {
      const apiLines = apis.map((a, i) => {
        const lines = [
          `### ${i + 1}. ${a.api_call}`,
          `- **Source:** ${a.source_name} | **File:** ${a.file_path}:${a.line_number}`,
          `- **Namespace:** ${a.namespace} | **Method:** ${a.method}`,
        ];
        if (a.code_context) {
          lines.push(`- **Context:**\n\`\`\`js\n${a.code_context.slice(0, 300)}\n\`\`\``);
        }
        return lines.join('\n');
      }).join('\n\n');

      sections.push(`## API Usages (${apis.length})\n\n${apiLines}`);
    }

    return {
      content: [{ type: 'text', text: sections.join('\n\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error searching block APIs: ${err.message}` }],
      isError: true,
    };
  }
}
