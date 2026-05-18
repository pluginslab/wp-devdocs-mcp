import { z } from 'zod';
import { searchThemeJsonProperties } from '../../db/sqlite.js';

export const searchThemeJsonPropertiesSchema = {
  name: 'search_theme_json_properties',
  description: 'Search valid theme.json property paths so you can stop guessing block-theme keys. Returns BM25-ranked paths with descriptions and value origin (enum / boolean / css_length / css_color / css_keyword / preset_ref:{type} / string / object / array / alias). Use this BEFORE writing any theme.json file.',
  inputSchema: {
    query: z.string().describe('Search query — property name fragment, CSS property, or description keyword'),
    context: z.enum(['settings', 'styles', 'top-level', 'settings.blocks', 'styles.blocks', 'styles.elements']).optional().describe('Restrict to a top-level subtree'),
    value_origin: z.string().optional().describe('Filter by value origin family, e.g. "preset_ref:color" or "enum"'),
    limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
  },
};

export function handleSearchThemeJsonProperties(args) {
  try {
    const results = searchThemeJsonProperties(args.query, {
      context: args.context,
      value_origin: args.value_origin,
      limit: args.limit || 20,
    });

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No theme.json properties found matching "${args.query}". The theme-json source may not be indexed — run: wp-hooks quick-add theme-json` }],
      };
    }

    const formatted = results.map((r, i) => {
      const lines = [
        `### ${i + 1}. ${r.path}`,
        `- **Context:** ${r.parent_context} | **Scope:** ${r.scope} | **Value origin:** ${r.value_origin}`,
      ];
      if (r.preset_name) lines.push(`- **Preset:** ${r.preset_name}`);
      if (r.enum_values) lines.push(`- **Allowed values:** ${r.enum_values}`);
      if (r.json_type) lines.push(`- **JSON type:** ${r.json_type}`);
      if (r.since) lines.push(`- **Since:** WP ${r.since}`);
      if (r.confirmed_by) lines.push(`- **Confirmed by:** ${r.confirmed_by}`);
      if (r.description) lines.push(`- **Description:** ${r.description.slice(0, 240)}${r.description.length > 240 ? '...' : ''}`);
      return lines.join('\n');
    }).join('\n\n');

    return {
      content: [{ type: 'text', text: `Found ${results.length} theme.json property path(s) matching "${args.query}":\n\n${formatted}` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error searching theme.json properties: ${err.message}` }],
      isError: true,
    };
  }
}
