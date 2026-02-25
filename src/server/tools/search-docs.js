import { z } from 'zod';
import { searchDocs } from '../../db/sqlite.js';

export const searchDocsSchema = {
  name: 'search_docs',
  description: 'Search WordPress official documentation (handbooks, REST API docs, WP-CLI reference, block editor guides, etc.) using full-text search. Returns BM25-ranked results. Use get_doc to retrieve full content for a specific result.',
  inputSchema: {
    query: z.string().describe('Search query — topic, function name, concept, or keyword'),
    doc_type: z.enum(['guide', 'tutorial', 'reference', 'api', 'howto', 'faq', 'general']).optional().describe('Filter by document type'),
    category: z.enum(['block-editor', 'plugins', 'rest-api', 'wp-cli', 'admin']).optional().describe('Filter by documentation category'),
    source: z.string().optional().describe('Filter by source name'),
    limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
  },
};

export function handleSearchDocs(args) {
  try {
    const results = searchDocs(args.query, {
      doc_type: args.doc_type,
      category: args.category,
      source: args.source,
      limit: args.limit || 20,
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No documentation found matching "${args.query}". Try broader terms or check that doc sources are indexed.` }],
      };
    }

    const formatted = results.map((d, i) => {
      const lines = [
        `### ${i + 1}. ${d.title}`,
        `- **Type:** ${d.doc_type} | **Category:** ${d.category || 'general'} | **Source:** ${d.source_name}`,
        `- **Slug:** ${d.slug}`,
      ];
      if (d.subcategory) lines.push(`- **Subcategory:** ${d.subcategory}`);
      if (d.description) lines.push(`- **Description:** ${d.description.slice(0, 200)}${d.description.length > 200 ? '...' : ''}`);
      lines.push(`- **ID:** ${d.id}`);
      return lines.join('\n');
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} doc(s) matching "${args.query}":\n\n${formatted}\n\n_Use get_doc with an ID or slug to read the full document._`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error searching docs: ${err.message}` }],
      isError: true,
    };
  }
}
