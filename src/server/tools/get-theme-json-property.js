import { z } from 'zod';
import { getThemeJsonProperty, isKnownBlockName } from '../../db/sqlite.js';
import { normalisePath, KNOWN_ELEMENTS } from '../../indexer/theme-json/path-utils.js';

export const getThemeJsonPropertySchema = {
  name: 'get_theme_json_property',
  description: 'Get the full spec for a specific theme.json property path. Accepts global paths (e.g. "settings.color.palette") or per-block/per-element paths (e.g. "styles.blocks.core/paragraph.typography.fontSize", "styles.elements.button.color.text"). Returns NOT_FOUND with similar-path suggestions when the path is invalid — use this to validate paths before writing them. Flags unknown block names as VALID_PATH_UNKNOWN_BLOCK.',
  inputSchema: {
    path: z.string().describe('Full theme.json property path, dot-delimited'),
  },
};

export function handleGetThemeJsonProperty(args) {
  try {
    const { normalised, blockName, elementName } = normalisePath(args.path);

    let result = getThemeJsonProperty(normalised);
    if (result.status !== 'VALID' && normalised !== args.path) {
      // Fall back to raw path in case the user passed a path that's already in placeholder form
      result = getThemeJsonProperty(args.path);
    }

    if (result.status === 'VALID') {
      const p = result.property;
      const lines = [
        `### ${args.path}`,
        `- **Status:** VALID`,
        `- **Context:** ${p.parent_context} | **Scope:** ${p.scope} | **Value origin:** ${p.value_origin}`,
      ];
      if (p.json_type) lines.push(`- **JSON type:** ${p.json_type}`);
      if (p.preset_name) lines.push(`- **Preset:** ${p.preset_name}`);
      if (p.enum_values) lines.push(`- **Allowed values:** ${p.enum_values}`);
      if (p.since) lines.push(`- **Since:** WP ${p.since}`);
      if (p.confirmed_by) lines.push(`- **Confirmed by:** ${p.confirmed_by}`);
      if (p.description) lines.push(`- **Description:** ${p.description}`);
      if (result.preset) {
        lines.push('');
        lines.push(`**Preset metadata:**`);
        lines.push(`- **Settings path:** ${result.preset.settings_path}`);
        if (result.preset.css_var_template) lines.push(`- **CSS variable template:** ${result.preset.css_var_template}`);
        if (result.preset.value_key) lines.push(`- **Value key:** ${result.preset.value_key}`);
        if (result.preset.css_properties) lines.push(`- **CSS properties:** ${result.preset.css_properties}`);
      }
      if (blockName) {
        const known = isKnownBlockName(blockName);
        lines.push('');
        lines.push(`- **Block name:** \`${blockName}\` — ${known ? 'KNOWN (registered)' : 'UNKNOWN (not in indexed block_registrations — may be a third-party block or typo)'}`);
        if (!known) {
          lines.push(`- **Status note:** VALID_PATH_UNKNOWN_BLOCK — path shape is valid, but the block name is not registered.`);
        }
      }
      if (elementName && !KNOWN_ELEMENTS.has(elementName)) {
        lines.push('');
        lines.push(`- **Element name:** \`${elementName}\` — UNKNOWN (not one of: ${[...KNOWN_ELEMENTS].join(', ')})`);
      } else if (elementName) {
        lines.push('');
        lines.push(`- **Element name:** \`${elementName}\` (valid)`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    // NOT_FOUND
    let text = `NOT FOUND — "${args.path}" is not a valid theme.json property path.`;
    if (result.similar.length > 0) {
      const suggestions = result.similar.map(s => `  - ${s.path} (${s.value_origin}${s.scope !== 'global' ? `, ${s.scope}` : ''})`).join('\n');
      text += `\n\nDid you mean one of these?\n${suggestions}`;
    } else {
      text += `\n\nNo similar paths found. Common mistakes:\n  - "colors" → use "color.palette" instead\n  - "color" alone in settings — try "color.text", "color.background", or "color.palette"\n  - Per-block paths need a slash: "styles.blocks.core/paragraph.*" not "styles.blocks.paragraph.*"`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error looking up theme.json property: ${err.message}` }],
      isError: true,
    };
  }
}

