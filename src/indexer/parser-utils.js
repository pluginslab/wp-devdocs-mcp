import { createHash } from 'node:crypto';

/**
 * Get 1-based line number for a character offset in content.
 */
export function getLineNumber(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract a code window around a given line.
 * Returns { codeBefore, codeAfter, hookLine }.
 */
export function extractCodeWindow(lines, lineIndex, before = 8, after = 4) {
  const start = Math.max(0, lineIndex - before);
  const end = Math.min(lines.length - 1, lineIndex + after);

  return {
    codeBefore: lines.slice(start, lineIndex).join('\n'),
    hookLine: lines[lineIndex] || '',
    codeAfter: lines.slice(lineIndex + 1, end + 1).join('\n'),
  };
}

/**
 * Generate a content hash from the relevant parts of a hook for change detection.
 */
export function generateContentHash(data) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    name: data.name,
    type: data.type,
    params: data.params,
    docblock: data.docblock,
    hookLine: data.hookLine,
  }));
  return hash.digest('hex').slice(0, 16);
}

/**
 * Infer a human-readable description from hook parts.
 */
export function inferDescription(data) {
  const parts = [];

  const typeLabel = {
    action: 'Action hook',
    filter: 'Filter hook',
    action_ref_array: 'Action hook (ref array)',
    filter_ref_array: 'Filter hook (ref array)',
    js_action: 'JavaScript action hook',
    js_filter: 'JavaScript filter hook',
  }[data.type] || 'Hook';

  parts.push(typeLabel);

  if (data.is_dynamic) {
    parts.push('(dynamic name)');
  }

  parts.push(`"${data.name}"`);

  if (data.php_function) {
    parts.push(`in ${data.php_function}()`);
  }
  if (data.class_name) {
    parts.push(`of class ${data.class_name}`);
  }

  if (data.param_count > 0) {
    parts.push(`with ${data.param_count} parameter${data.param_count > 1 ? 's' : ''}`);
  }

  return parts.join(' ');
}

/**
 * Extract docblock from lines above a given line index.
 * Looks up to `maxLines` lines above for a closing doc comment.
 */
export function extractDocblock(lines, lineIndex, maxLines = 5) {
  const docLines = [];
  let foundEnd = false;

  for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - maxLines); i--) {
    const line = lines[i].trim();

    if (!foundEnd) {
      // Look for closing */ or a @-annotated line or * continuation
      if (line.endsWith('*/') || line.startsWith('*') || line.startsWith('/**')) {
        foundEnd = true;
        docLines.unshift(lines[i]);
      } else if (line === '' || line.startsWith('//')) {
        continue;
      } else {
        break;
      }
    } else {
      docLines.unshift(lines[i]);
      if (line.startsWith('/**') || line.startsWith('/*')) {
        break;
      }
    }
  }

  if (docLines.length === 0) return '';
  return docLines.join('\n').trim();
}

/**
 * Find the enclosing function/method name for a given line index by scanning upward.
 */
export function findEnclosingFunction(lines, lineIndex) {
  // PHP function pattern
  const phpFuncRe = /(?:public|protected|private|static|\s)*function\s+(\w+)\s*\(/;
  // JS function patterns
  const jsFuncRe = /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\(|=>))/;

  let braceDepth = 0;
  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i];

    // Count braces to track nesting
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === '}') braceDepth++;
      if (line[c] === '{') braceDepth--;
    }

    const phpMatch = line.match(phpFuncRe);
    if (phpMatch && braceDepth <= 0) return phpMatch[1];

    const jsMatch = line.match(jsFuncRe);
    if (jsMatch && braceDepth <= 0) return jsMatch[1] || jsMatch[2];
  }
  return null;
}

/**
 * Find the enclosing class name for a given line index by scanning upward.
 */
export function findEnclosingClass(lines, lineIndex) {
  const classRe = /(?:abstract\s+)?class\s+(\w+)/;
  let braceDepth = 0;
  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i];
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === '}') braceDepth++;
      if (line[c] === '{') braceDepth--;
    }
    const match = line.match(classRe);
    if (match && braceDepth <= 0) return match[1];
  }
  return null;
}
