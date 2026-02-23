import {
  getLineNumber,
  extractCodeWindow,
  generateContentHash,
  inferDescription,
  extractDocblock,
  findEnclosingFunction,
} from './parser-utils.js';

// JS hook patterns — addAction/addFilter from @wordpress/hooks or wp.hooks
const JS_HOOK_REGEX = /\b(?:addAction|addFilter|applyFilters|doAction)\s*\(\s*/g;

const JS_TYPE_MAP = {
  addAction: 'js_action',
  addFilter: 'js_filter',
  applyFilters: 'js_filter',
  doAction: 'js_action',
};

// Block registration patterns
const BLOCK_REG_REGEX = /\b(registerBlockType|registerBlockVariation|registerBlockStyle|registerBlockCollection)\s*\(\s*/g;

// WP API usage patterns
const API_USAGE_REGEX = /\bwp\.(blocks|editor|blockEditor|data|element|components|plugins|editPost|editSite|hooks|i18n|richText)\s*\.\s*(\w+)/g;

/**
 * Parse a JS/TS file and extract hooks, block registrations, and API usages.
 */
export function parseJsFile(content, filePath, sourceId) {
  const hooks = [];
  const blocks = [];
  const apis = [];
  const lines = content.split('\n');

  // --- JS Hooks ---
  let match;
  JS_HOOK_REGEX.lastIndex = 0;
  while ((match = JS_HOOK_REGEX.exec(content)) !== null) {
    const funcName = match[0].match(/\b(addAction|addFilter|applyFilters|doAction)/)[1];
    const type = JS_TYPE_MAP[funcName];
    const startOffset = match.index + match[0].length;

    const argsStr = extractJsArguments(content, startOffset);
    if (!argsStr) continue;

    const args = splitJsArguments(argsStr);
    if (args.length === 0) continue;

    const rawName = args[0].trim();
    const hookName = cleanJsHookName(rawName);
    if (!hookName) continue;

    const isDynamic = rawName.includes('`') || rawName.includes('${') || rawName.includes('+');

    const lineNumber = getLineNumber(content, match.index);
    const lineIndex = lineNumber - 1;

    const params = args.slice(1).map(p => p.trim()).filter(Boolean);
    const docblock = extractDocblock(lines, lineIndex);
    const { codeBefore, hookLine, codeAfter } = extractCodeWindow(lines, lineIndex);
    const jsFunction = findEnclosingFunction(lines, lineIndex);

    const hookData = {
      source_id: sourceId,
      file_path: filePath,
      line_number: lineNumber,
      name: hookName,
      type,
      php_function: jsFunction || null,
      params: params.join(', ') || null,
      param_count: params.length,
      docblock: docblock || null,
      inferred_description: null,
      function_context: jsFunction || null,
      class_name: null,
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

  // --- Block Registrations ---
  BLOCK_REG_REGEX.lastIndex = 0;
  while ((match = BLOCK_REG_REGEX.exec(content)) !== null) {
    const regFunc = match[1];
    const startOffset = match.index + match[0].length;

    const argsStr = extractJsArguments(content, startOffset);
    if (!argsStr) continue;

    const args = splitJsArguments(argsStr);
    if (args.length === 0) continue;

    const blockName = cleanJsHookName(args[0].trim());
    if (!blockName) continue;

    const lineNumber = getLineNumber(content, match.index);
    const lineIndex = lineNumber - 1;
    const { codeBefore, hookLine, codeAfter } = extractCodeWindow(lines, lineIndex, 4, 20);

    // Try to extract settings object
    const settingsStr = args.length > 1 ? args.slice(1).join(', ') : '';
    const blockTitle = extractProperty(settingsStr, 'title');
    const blockCategory = extractProperty(settingsStr, 'category');

    const codeContext = [codeBefore, hookLine, codeAfter].filter(Boolean).join('\n');

    const blockData = {
      source_id: sourceId,
      file_path: filePath,
      line_number: lineNumber,
      block_name: blockName,
      block_title: blockTitle || null,
      block_category: blockCategory || null,
      block_attributes: null,
      supports: null,
      code_context: codeContext.slice(0, 2000) || null,
      content_hash: null,
    };

    blockData.content_hash = generateContentHash({
      name: blockName,
      type: regFunc,
      params: settingsStr,
      docblock: '',
      hookLine: hookLine,
    });

    blocks.push(blockData);
  }

  // --- API Usages ---
  API_USAGE_REGEX.lastIndex = 0;
  while ((match = API_USAGE_REGEX.exec(content)) !== null) {
    const namespace = match[1];
    const method = match[2];
    const apiCall = `wp.${namespace}.${method}`;

    const lineNumber = getLineNumber(content, match.index);
    const lineIndex = lineNumber - 1;
    const { codeBefore, hookLine, codeAfter } = extractCodeWindow(lines, lineIndex, 3, 3);
    const codeContext = [codeBefore, hookLine, codeAfter].filter(Boolean).join('\n');

    const apiData = {
      source_id: sourceId,
      file_path: filePath,
      line_number: lineNumber,
      api_call: apiCall,
      namespace,
      method,
      code_context: codeContext.slice(0, 2000) || null,
      content_hash: null,
    };

    apiData.content_hash = generateContentHash({
      name: apiCall,
      type: 'api_usage',
      params: '',
      docblock: '',
      hookLine: hookLine,
    });

    apis.push(apiData);
  }

  return { hooks, blocks, apis };
}

/**
 * Extract arguments string (handles nested parens, brackets, braces, strings, template literals).
 */
function extractJsArguments(content, start) {
  let depth = 1;
  let i = start;
  const max = Math.min(start + 5000, content.length);

  while (i < max && depth > 0) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === "'" || ch === '"' || ch === '`') {
      i = skipJsString(content, i);
    } else if (ch === '/' && i + 1 < max && content[i + 1] === '/') {
      // Line comment — skip to end of line
      while (i < max && content[i] !== '\n') i++;
    } else if (ch === '/' && i + 1 < max && content[i + 1] === '*') {
      // Block comment
      i += 2;
      while (i < max && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i++; // skip past /
    }
    if (depth > 0) i++;
  }

  if (depth !== 0) return null;
  return content.slice(start, i);
}

function skipJsString(content, i) {
  const quote = content[i];
  i++;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && content[i] === '$' && content[i + 1] === '{') {
      // Template literal expression — skip nested
      i += 2;
      let depth = 1;
      while (i < content.length && depth > 0) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') depth--;
        if (depth > 0) i++;
      }
    }
    if (content[i] === quote) return i;
    i++;
  }
  return i;
}

function splitJsArguments(argsStr) {
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

    if (ch === "'" || ch === '"' || ch === '`') {
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

function cleanJsHookName(raw) {
  const trimmed = raw.trim();

  // Simple quoted string
  const simpleMatch = trimmed.match(/^['"`]([^'"`]+)['"`]$/);
  if (simpleMatch) return simpleMatch[1];

  // Template literal without expressions
  const templateMatch = trimmed.match(/^`([^$`]+)`$/);
  if (templateMatch) return templateMatch[1];

  // Template literal with expressions
  if (trimmed.startsWith('`')) {
    return trimmed.replace(/`/g, '').replace(/\$\{[^}]+\}/g, '{dynamic}') || null;
  }

  // String concatenation
  if (trimmed.includes('+')) {
    const parts = trimmed.split(/\s*\+\s*/);
    const cleaned = parts.map(part => {
      const qm = part.trim().match(/^['"`]([^'"`]*)['"`]$/);
      if (qm) return qm[1];
      return '{dynamic}';
    }).join('');
    return cleaned || null;
  }

  return null;
}

function extractProperty(objStr, prop) {
  const regex = new RegExp(`(?:['"]?${prop}['"]?)\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
  const match = objStr.match(regex);
  return match ? match[1] : null;
}
