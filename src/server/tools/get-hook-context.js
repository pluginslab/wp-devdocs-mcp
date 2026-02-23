import { z } from 'zod';
import { getHookContext } from '../../db/sqlite.js';

export const getHookContextSchema = {
  name: 'get_hook_context',
  description: 'Get full surrounding code context for a specific WordPress hook. Provide a hook ID (from search results) or exact hook name. Returns the code window around the hook, including the enclosing function, docblock, and parameters.',
  inputSchema: {
    hook: z.string().describe('Hook ID (numeric) or exact hook name'),
  },
};

export function handleGetHookContext(args) {
  try {
    const hook = getHookContext(args.hook);

    if (!hook) {
      return {
        content: [{ type: 'text', text: `Hook not found: "${args.hook}". Use search_hooks to find hooks first.` }],
      };
    }

    const sections = [
      `## ${hook.name}`,
      `**Type:** ${hook.type} | **Source:** ${hook.source_name}`,
      `**File:** ${hook.file_path}:${hook.line_number}`,
    ];

    if (hook.status === 'removed') sections.push('**Status:** REMOVED');
    if (hook.class_name) sections.push(`**Class:** ${hook.class_name}`);
    if (hook.php_function) sections.push(`**Function:** ${hook.php_function}()`);
    if (hook.params) sections.push(`**Parameters:** ${hook.params}`);
    if (hook.is_dynamic) sections.push('**Dynamic name:** yes');

    if (hook.docblock) {
      sections.push(`\n### Docblock\n\`\`\`\n${hook.docblock}\n\`\`\``);
    }

    if (hook.inferred_description) {
      sections.push(`\n### Description\n${hook.inferred_description}`);
    }

    // Code context
    const codeLines = [];
    if (hook.code_before) codeLines.push(hook.code_before);
    if (hook.hook_line) codeLines.push(`>>> ${hook.hook_line}`);
    if (hook.code_after) codeLines.push(hook.code_after);

    if (codeLines.length > 0) {
      sections.push(`\n### Code Context\n\`\`\`php\n${codeLines.join('\n')}\n\`\`\``);
    }

    return {
      content: [{ type: 'text', text: sections.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting hook context: ${err.message}` }],
      isError: true,
    };
  }
}
