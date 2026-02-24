import {
  getLineNumber,
  extractCodeWindow,
  generateContentHash,
  inferDescription,
  extractDocblock,
  findEnclosingFunction,
  findEnclosingClass,
} from './parser-utils.js';

// Matches do_action(), apply_filters(), do_action_ref_array(), apply_filters_ref_array()
const HOOK_REGEX = /\b(do_action|apply_filters|do_action_ref_array|apply_filters_ref_array)\s*\(\s*/g;

const TYPE_MAP = {
  do_action: 'action',
  apply_filters: 'filter',
  do_action_ref_array: 'action_ref_array',
  apply_filters_ref_array: 'filter_ref_array',
};

/**
 * Parse a PHP file and extract all WordPress hooks.
 * @param {string} content - File content
 * @param {string} filePath - Relative file path
 * @param {number} sourceId - Source ID
 * @returns {Array} Array of hook data objects
 */
export function parsePhpFile(content, filePath, sourceId) {
  const hooks = [];
  const lines = content.split('\n');

  let match;
  HOOK_REGEX.lastIndex = 0;

  while ((match = HOOK_REGEX.exec(content)) !== null) {
    const funcName = match[1];
    const type = TYPE_MAP[funcName];
    const startOffset = match.index + match[0].length;

    // Extract the arguments string (handle nested parentheses)
    const argsStr = extractArguments(content, startOffset);
    if (!argsStr) continue;

    const args = splitArguments(argsStr);
    if (args.length === 0) continue;

    // First arg is the hook name
    const rawName = args[0].trim();
    const hookName = cleanHookName(rawName);
    if (!hookName) continue;

    const isDynamic = rawName.includes('$') || (rawName.includes('.') && !rawName.startsWith("'") && !rawName.startsWith('"'));

    const lineNumber = getLineNumber(content, match.index);
    const lineIndex = lineNumber - 1;

    const params = args.slice(1).map(p => p.trim()).filter(Boolean);
    const paramCount = params.length;

    const docblock = extractDocblock(lines, lineIndex);
    const { codeBefore, hookLine, codeAfter } = extractCodeWindow(lines, lineIndex);
    const phpFunction = findEnclosingFunction(lines, lineIndex);
    const className = findEnclosingClass(lines, lineIndex);

    const hookData = {
      source_id: sourceId,
      file_path: filePath,
      line_number: lineNumber,
      name: hookName,
      type,
      php_function: phpFunction || null,
      params: params.join(', ') || null,
      param_count: paramCount,
      docblock: docblock || null,
      inferred_description: null,
      function_context: phpFunction || null,
      class_name: className || null,
      code_before: codeBefore || null,
      code_after: codeAfter || null,
      hook_line: hookLine || null,
      is_dynamic: isDynamic ? 1 : 0,
      content_hash: null,
    };

    hookData.inferred_description = inferDescription(hookData);
    hookData.content_hash = generateContentHash(hookData);

    hooks.push(hookData);
  }

  return hooks;
}

/**
 * Extract arguments string from content starting at the position after opening paren.
 */
function extractArguments(content, start) {
  let depth = 1;
  let i = start;
  const max = Math.min(start + 2000, content.length); // Safety limit

  while (i < max && depth > 0) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === "'" || ch === '"') {
      // Skip string literals
      i = skipString(content, i);
    }
    if (depth > 0) i++;
  }

  if (depth !== 0) return null;
  return content.slice(start, i);
}

/**
 * Skip a string literal starting at position i.
 */
function skipString(content, i) {
  const quote = content[i];
  i++;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === quote) return i;
    i++;
  }
  return i;
}

/**
 * Split arguments by comma, respecting nesting and strings.
 */
function splitArguments(argsStr) {
  const args = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (inString) {
      current += ch;
      if (ch === '\\') {
        i++;
        if (i < argsStr.length) current += argsStr[i];
        continue;
      }
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) args.push(current);
  return args;
}

/**
 * Clean a hook name string — remove quotes, handle concatenation.
 */
function cleanHookName(raw) {
  const trimmed = raw.trim();

  // Simple quoted string: 'hook_name' or "hook_name"
  const simpleMatch = trimmed.match(/^['"]([^'"]+)['"]$/);
  if (simpleMatch) return simpleMatch[1];

  // Concatenated string: 'prefix_' . $var . '_suffix' → prefix_{dynamic}_suffix
  if (trimmed.includes('.') || trimmed.includes('$')) {
    const parts = trimmed.split(/\s*\.\s*/);
    const cleaned = parts.map(part => {
      const qm = part.trim().match(/^['"]([^'"]*)['"]$/);
      if (qm) return qm[1];
      return '{dynamic}';
    }).join('');
    return cleaned || null;
  }

  // Variable only
  if (trimmed.startsWith('$')) return '{dynamic}';

  return null;
}
