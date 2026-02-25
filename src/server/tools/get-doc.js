import { z } from 'zod';
import { getDoc } from '../../db/sqlite.js';

export const getDocSchema = {
  name: 'get_doc',
  description: 'Get the full content of a WordPress documentation page by its ID (numeric) or slug. Returns the complete markdown content along with metadata.',
  inputSchema: {
    doc: z.string().describe('Document ID (numeric) or slug string'),
  },
};

export function handleGetDoc(args) {
  try {
    const doc = getDoc(args.doc);

    if (!doc) {
      return {
        content: [{ type: 'text', text: `Document not found: "${args.doc}". Use search_docs to find documents first.` }],
      };
    }

    const sections = [
      `## ${doc.title}`,
      `**Type:** ${doc.doc_type} | **Category:** ${doc.category || 'general'} | **Source:** ${doc.source_name}`,
      `**File:** ${doc.file_path}`,
      `**Slug:** ${doc.slug}`,
    ];

    if (doc.subcategory) sections.push(`**Subcategory:** ${doc.subcategory}`);
    if (doc.status === 'removed') sections.push('**Status:** REMOVED');

    if (doc.description) {
      sections.push(`\n### Summary\n${doc.description}`);
    }

    sections.push(`\n### Content\n${doc.content}`);

    if (doc.code_examples) {
      try {
        const examples = JSON.parse(doc.code_examples);
        if (examples.length > 0) {
          sections.push(`\n### Code Examples (${examples.length})`);
          for (const ex of examples) {
            sections.push(`\`\`\`${ex.language}\n${ex.code}\n\`\`\``);
          }
        }
      } catch {
        // Invalid JSON — skip
      }
    }

    if (doc.metadata) {
      try {
        const meta = JSON.parse(doc.metadata);
        const metaParts = [];
        if (meta.endpoints) metaParts.push(`**Endpoints:** ${meta.endpoints.map(e => `${e.method} ${e.route}`).join(', ')}`);
        if (meta.commands) metaParts.push(`**Commands:** ${meta.commands.join(', ')}`);
        if (meta.package_refs) metaParts.push(`**Packages:** ${meta.package_refs.join(', ')}`);
        if (meta.function_refs) metaParts.push(`**Functions:** ${meta.function_refs.join(', ')}`);
        if (meta.hook_refs) metaParts.push(`**Hooks:** ${meta.hook_refs.join(', ')}`);
        if (meta.config_defines) metaParts.push(`**Config defines:** ${meta.config_defines.join(', ')}`);
        if (metaParts.length > 0) {
          sections.push(`\n### Metadata\n${metaParts.join('\n')}`);
        }
      } catch {
        // Invalid JSON — skip
      }
    }

    return {
      content: [{ type: 'text', text: sections.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting document: ${err.message}` }],
      isError: true,
    };
  }
}
