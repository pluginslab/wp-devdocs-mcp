/**
 * Walks the Gutenberg `schemas/json/theme.json` JSON Schema and emits a flat list of
 * property records, one per dotted path. The result feeds the merge step which assigns
 * value_origin and confirmation source.
 *
 * Two special branches get collapsed into placeholder paths so the index stays small:
 *   - settings.blocks.core/X.*  and  styles.blocks.core/X.*  →  styles.blocks.{block-name}.*
 *   - styles.elements.X.*                                    →  styles.elements.{element-name}.*
 */

const BLOCK_PLACEHOLDER = '{block-name}';
const ELEMENT_PLACEHOLDER = '{element-name}';

/**
 * Resolve a `$ref` like `#/definitions/foo` against the root schema.
 * Returns the referenced node or null when unresolvable.
 */
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = root;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) {
      node = node[p];
    } else {
      return null;
    }
  }
  return node;
}

/**
 * Merge an `allOf` list into a single shape by walking each branch and recursively
 * collecting properties. Cycles are broken via the visited set.
 */
function flattenAllOf(node, root, visited) {
  if (!Array.isArray(node.allOf)) return node;
  const merged = { type: 'object', properties: {} };
  for (const branch of node.allOf) {
    const resolved = resolveNode(branch, root, visited);
    if (resolved && resolved.properties) {
      Object.assign(merged.properties, resolved.properties);
    }
    if (resolved && resolved.description && !merged.description) {
      merged.description = resolved.description;
    }
  }
  // Preserve the node's own properties if it also defines them alongside allOf
  if (node.properties) Object.assign(merged.properties, node.properties);
  return merged;
}

/**
 * Resolve a node by walking `$ref` and `allOf` until we reach a concrete shape.
 * `visited` tracks ref strings already on the stack to break cycles.
 */
function resolveNode(node, root, visited = new Set()) {
  if (!node || typeof node !== 'object') return node;

  if (node.$ref) {
    if (visited.has(node.$ref)) return { type: 'object', properties: {} };
    const next = resolveRef(root, node.$ref);
    if (!next) return null;
    visited.add(node.$ref);
    const out = resolveNode(next, root, visited);
    visited.delete(node.$ref);
    return out;
  }

  if (Array.isArray(node.allOf)) {
    return flattenAllOf(node, root, visited);
  }

  return node;
}

/**
 * Detect whether a `properties` block looks like an enumeration of block names
 * (every key starts with `<namespace>/<name>` and every value is a `$ref` to the
 * same complete-properties schema).
 */
function isBlockEnumProperties(props) {
  const keys = Object.keys(props || {});
  if (keys.length < 5) return false;
  return keys.every(k => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(k));
}

/**
 * Detect a styles-elements enumeration: keys are bare element slugs like
 * "link", "heading", "button", "h1"... matched by an `additionalProperties: false`
 * shape. Easier: every key is `^[a-z][a-zA-Z0-9]*$` AND there are 5+ keys.
 */
function isElementEnumProperties(props) {
  const keys = Object.keys(props || {});
  if (keys.length < 4) return false;
  return keys.every(k => /^[a-z][a-zA-Z0-9]*$/.test(k));
}

/**
 * Walk a resolved node and collect property records.
 *
 * @param {object} node - Resolved schema node (no remaining $ref/allOf at top)
 * @param {string} pathPrefix - Dot-delimited path built so far
 * @param {string} parentContext - 'top-level' | 'settings' | 'settings.blocks' | 'styles' | 'styles.blocks' | 'styles.elements' | 'styles.variations'
 * @param {string} scope - 'global' | 'per-block' | 'per-element'
 * @param {Map<string, object>} out - Accumulator keyed by path
 * @param {object} root - Root schema (for $ref resolution)
 * @param {Set<string>} pathSeen - Set of path-prefixes seen to break recursion
 */
function walk(node, pathPrefix, parentContext, scope, out, root, pathSeen) {
  const resolved = resolveNode(node, root);
  if (!resolved) return;

  // Avoid re-walking nodes for the same path (cycle safety)
  const seenKey = `${pathPrefix}||${parentContext}`;
  if (pathSeen.has(seenKey)) return;
  pathSeen.add(seenKey);

  // Record this node if it's a non-root path
  if (pathPrefix) {
    const existing = out.get(pathPrefix);
    if (!existing) {
      out.set(pathPrefix, {
        path: pathPrefix,
        parent_context: parentContext,
        scope,
        json_type: resolved.type || (resolved.enum ? 'string' : 'object'),
        description: resolved.description || null,
        enum: resolved.enum || null,
        default: resolved.default,
        schema_ref: pathPrefix,
      });
    } else if (resolved.description && !existing.description) {
      existing.description = resolved.description;
    }
  }

  // Recurse into properties
  if (resolved.properties && typeof resolved.properties === 'object') {
    // Detect per-block / per-element enumerations and collapse them
    if (parentContext === 'settings' && pathPrefix === 'settings.blocks' && isBlockEnumProperties(resolved.properties)) {
      const firstBlockKey = Object.keys(resolved.properties)[0];
      const blockSchema = resolveNode(resolved.properties[firstBlockKey], root);
      const placeholder = `settings.blocks.${BLOCK_PLACEHOLDER}`;
      out.set(placeholder, {
        path: placeholder,
        parent_context: 'settings.blocks',
        scope: 'per-block',
        json_type: 'object',
        description: 'Per-block settings overrides — replace {block-name} with a registered block name like core/paragraph.',
        enum: null,
        default: undefined,
        schema_ref: placeholder,
      });
      walk(blockSchema, placeholder, 'settings.blocks', 'per-block', out, root, pathSeen);
      return;
    }
    if (parentContext === 'styles' && pathPrefix === 'styles.blocks' && isBlockEnumProperties(resolved.properties)) {
      const firstBlockKey = Object.keys(resolved.properties)[0];
      const blockSchema = resolveNode(resolved.properties[firstBlockKey], root);
      const placeholder = `styles.blocks.${BLOCK_PLACEHOLDER}`;
      out.set(placeholder, {
        path: placeholder,
        parent_context: 'styles.blocks',
        scope: 'per-block',
        json_type: 'object',
        description: 'Per-block style overrides — replace {block-name} with a registered block name.',
        enum: null,
        default: undefined,
        schema_ref: placeholder,
      });
      walk(blockSchema, placeholder, 'styles.blocks', 'per-block', out, root, pathSeen);
      return;
    }
    if (parentContext === 'styles' && pathPrefix === 'styles.elements' && isElementEnumProperties(resolved.properties)) {
      const firstElementKey = Object.keys(resolved.properties)[0];
      const elementSchema = resolveNode(resolved.properties[firstElementKey], root);
      const placeholder = `styles.elements.${ELEMENT_PLACEHOLDER}`;
      out.set(placeholder, {
        path: placeholder,
        parent_context: 'styles.elements',
        scope: 'per-element',
        json_type: 'object',
        description: 'Per-element style overrides — replace {element-name} with link, heading, button, h1..h6, caption, cite, textInput, or select.',
        enum: null,
        default: undefined,
        schema_ref: placeholder,
      });
      walk(elementSchema, placeholder, 'styles.elements', 'per-element', out, root, pathSeen);
      return;
    }

    for (const [key, child] of Object.entries(resolved.properties)) {
      // Skip the meta key
      if (key === '//') continue;

      const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      let nextContext = parentContext;
      if (!pathPrefix) {
        // Top-level keys — set context
        if (key === 'settings') nextContext = 'settings';
        else if (key === 'styles') nextContext = 'styles';
        else nextContext = 'top-level';
      } else if (pathPrefix === 'settings' && key === 'blocks') {
        nextContext = 'settings';
      } else if (pathPrefix === 'styles' && key === 'blocks') {
        nextContext = 'styles';
      } else if (pathPrefix === 'styles' && key === 'elements') {
        nextContext = 'styles';
      }

      walk(child, nextPath, nextContext, scope, out, root, pathSeen);
    }
  }

  // Array items — emit a `[].child` path so things like settings.color.palette[].slug are findable
  if (resolved.type === 'array' && resolved.items) {
    const itemPath = `${pathPrefix}[]`;
    const itemNode = resolveNode(resolved.items, root);
    if (itemNode && itemNode.properties) {
      walk(itemNode, itemPath, parentContext, scope, out, root, pathSeen);
    }
  }
}

/**
 * Parse the Gutenberg theme.json JSON Schema and emit a list of property records.
 *
 * @param {object} schema - The parsed JSON Schema object
 * @returns {Array<{ path, parent_context, scope, json_type, description, enum, default, schema_ref }>}
 */
export function parseSchema(schema) {
  const out = new Map();
  const pathSeen = new Set();

  walk(schema, '', 'top-level', 'global', out, schema, pathSeen);

  return Array.from(out.values());
}
