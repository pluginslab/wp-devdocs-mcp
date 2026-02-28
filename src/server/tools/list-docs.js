import { z } from 'zod';
import { listDocs, getDocCategoryCounts } from '../../db/sqlite.js';

export const listDocsSchema = {
  name: 'list_docs',
  description: 'List available WordPress documentation pages, optionally filtered by type, category, or source. Returns titles and slugs grouped by category. Use search_docs for full-text search or get_doc to read a specific page. Tip: filter by category for complete listings — unfiltered results may be truncated.',
  inputSchema: {
    doc_type: z.enum(['guide', 'tutorial', 'reference', 'api', 'howto', 'faq', 'general']).optional().describe('Filter by document type'),
    category: z.enum(['block-editor', 'plugins', 'rest-api', 'wp-cli', 'admin']).optional().describe('Filter by documentation category'),
    source: z.string().optional().describe('Filter by source name'),
    limit: z.number().min(1).max(200).optional().describe('Max results (default 50)'),
  },
};

export function handleListDocs(args) {
  try {
    const limit = args.limit || 50;
    const results = listDocs({
      doc_type: args.doc_type,
      category: args.category,
      source: args.source,
      limit,
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No documentation pages found. Check that doc sources are indexed.' }],
      };
    }

    // Group by category
    const grouped = {};
    for (const doc of results) {
      const cat = doc.category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(doc);
    }

    const sections = [];
    for (const [category, docs] of Object.entries(grouped)) {
      const lines = docs.map(d => {
        const parts = [`- **${d.title}** (${d.doc_type})`];
        parts.push(`  Slug: \`${d.slug}\` | Source: ${d.source_name}`);
        if (d.description) parts.push(`  ${d.description.slice(0, 120)}${d.description.length > 120 ? '...' : ''}`);
        return parts.join('\n');
      });
      sections.push(`## ${category} (${docs.length})\n${lines.join('\n')}`);
    }

    let text = `${results.length} documentation page(s):\n\n${sections.join('\n\n')}`;

    // If results hit the limit and no category filter, show full category counts
    if (results.length >= limit && !args.category) {
      const counts = getDocCategoryCounts();
      const total = counts.reduce((sum, c) => sum + c.count, 0);
      const summary = counts.map(c => `  - ${c.category || 'general'}: ${c.count} pages`).join('\n');
      text += `\n\n---\n**Results truncated** (showing ${results.length} of ${total} total). All categories:\n${summary}\n\nFilter by category for complete listings.`;
    }

    text += '\n\n_Use get_doc with a slug to read the full document._';

    return {
      content: [{ type: 'text', text }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error listing docs: ${err.message}` }],
      isError: true,
    };
  }
}
