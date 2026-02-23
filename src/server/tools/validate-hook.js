import { z } from 'zod';
import { validateHook } from '../../db/sqlite.js';

export const validateHookSchema = {
  name: 'validate_hook',
  description: 'Check if a WordPress hook name is valid (exists in indexed sources). Returns VALID, NOT_FOUND, or REMOVED status with similar suggestions when not found. Use this to prevent hook name hallucination.',
  inputSchema: {
    hook_name: z.string().describe('Exact hook name to validate'),
  },
};

export function handleValidateHook(args) {
  try {
    const result = validateHook(args.hook_name);

    if (result.status === 'VALID') {
      const locations = result.hooks.map(h =>
        `  - ${h.source_name}: ${h.file_path}:${h.line_number} (${h.type})`
      ).join('\n');

      return {
        content: [{
          type: 'text',
          text: `VALID — Hook "${args.hook_name}" exists in ${result.hooks.length} location(s):\n${locations}`,
        }],
      };
    }

    if (result.status === 'REMOVED') {
      const locations = result.hooks.map(h =>
        `  - ${h.source_name}: ${h.file_path}:${h.line_number} (removed ${h.removed_at || 'unknown'})`
      ).join('\n');

      return {
        content: [{
          type: 'text',
          text: `REMOVED — Hook "${args.hook_name}" was found but has been removed:\n${locations}\n\nThis hook may have been deprecated or renamed.`,
        }],
      };
    }

    // NOT_FOUND
    let text = `NOT FOUND — Hook "${args.hook_name}" does not exist in any indexed source.`;

    if (result.similar.length > 0) {
      const suggestions = result.similar.map(s =>
        `  - ${s.name} (${s.type}) [${s.source_name}]`
      ).join('\n');
      text += `\n\nDid you mean one of these?\n${suggestions}`;
    }

    return {
      content: [{ type: 'text', text }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error validating hook: ${err.message}` }],
      isError: true,
    };
  }
}
