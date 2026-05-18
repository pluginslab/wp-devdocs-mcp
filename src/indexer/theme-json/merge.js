/**
 * Merges schema-derived property records with class-derived constants to produce the final
 * shape the indexer writes to SQLite. The big job here is computing each property's
 * `value_origin` from the finite taxonomy:
 *
 *   enum | boolean | css_length | css_color | css_keyword |
 *   preset_ref:{type} | string | object | array | alias
 *
 * Plus emitting:
 *   - preset rows (`theme_json_presets`) from PRESETS_METADATA
 *   - alias rows (`INDIRECT_PROPERTIES_METADATA`) so things like `gap` route to
 *     `styles.spacing.blockGap`
 */

const PRESET_NAME_BY_PATH_KEY = {
  'color.palette': 'color',
  'color.gradients': 'gradient',
  'color.duotone': 'duotone',
  'typography.fontSizes': 'font-size',
  'typography.fontFamilies': 'font-family',
  'spacing.spacingSizes': 'spacing',
  'shadow.presets': 'shadow',
  'border.radiusSizes': 'border-radius',
  'dimensions.aspectRatios': 'aspect-ratio',
  'dimensions.dimensionSizes': 'dimension',
};

/**
 * Build a lookup from CSS property name → preset name based on PRESETS_METADATA.
 * Example: 'background-color' → 'color', 'padding' → 'spacing'.
 */
function buildCssPropertyToPresetMap(presetsMetadata) {
  const out = new Map();
  if (!Array.isArray(presetsMetadata)) return out;
  for (const preset of presetsMetadata) {
    const pathKey = Array.isArray(preset.path) ? preset.path.join('.') : '';
    const presetName = PRESET_NAME_BY_PATH_KEY[pathKey];
    if (!presetName) continue;
    const cssProps = Array.isArray(preset.properties) ? preset.properties : [];
    for (const cssProp of cssProps) {
      out.set(cssProp, presetName);
    }
  }
  return out;
}

/**
 * Build a lookup from CSS property name → category for the css_length/css_color/css_keyword
 * classification. Derived from naming conventions in WP's PROPERTIES_METADATA.
 */
const CSS_LENGTH_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'width', 'height', 'min-height', 'max-width',
  'font-size', 'letter-spacing', 'line-height', 'text-indent',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-width', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width',
  'outline-width', 'outline-offset',
  'column-gap', 'row-gap', 'gap', 'aspect-ratio', 'column-count',
]);

const CSS_COLOR_PROPS = new Set([
  'color', 'background-color', 'background', 'border-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color',
]);

const CSS_KEYWORD_PROPS_TO_KEYWORDS = {
  'font-style': null,
  'font-weight': null,
  'text-transform': null,
  'text-decoration': null,
  'text-align': null,
  'writing-mode': null,
  'border-style': null,
  'border-top-style': null,
  'border-right-style': null,
  'border-bottom-style': null,
  'border-left-style': null,
  'outline-style': null,
  'background-repeat': null,
  'background-attachment': null,
  'background-position': null,
  'background-size': null,
  'background-image': null,
};

/**
 * Build a lookup from theme.json path → CSS property name using PROPERTIES_METADATA.
 * Example: 'color.text' → 'color', 'typography.fontSize' → 'font-size'.
 */
function buildPathToCssMap(propertiesMetadata) {
  const out = new Map();
  if (!propertiesMetadata || typeof propertiesMetadata !== 'object') return out;
  for (const [cssProp, pathArr] of Object.entries(propertiesMetadata)) {
    if (!Array.isArray(pathArr)) continue;
    // Skip the --wp--style--root--padding-* aliases; they refer to the same paths
    if (cssProp.startsWith('--wp--')) continue;
    const pathKey = pathArr.join('.');
    if (!out.has(pathKey)) out.set(pathKey, cssProp);
  }
  return out;
}

/**
 * Strip the leading 'styles.' (or 'styles.blocks.{block-name}.' / 'styles.elements.{element-name}.')
 * from a styles path so we can compare against PROPERTIES_METADATA paths
 * (which are stored as e.g. 'color.text' not 'styles.color.text').
 */
function normalizeStylesPath(path) {
  if (path.startsWith('styles.blocks.{block-name}.')) {
    return path.slice('styles.blocks.{block-name}.'.length);
  }
  if (path.startsWith('styles.elements.{element-name}.')) {
    return path.slice('styles.elements.{element-name}.'.length);
  }
  if (path.startsWith('styles.')) {
    return path.slice('styles.'.length);
  }
  return null;
}

/**
 * Classify a property into a value_origin.
 */
function classifyValueOrigin(record, ctx) {
  const { pathToCss, cssPropToPreset } = ctx;

  // 1. Explicit enum from schema wins
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return { value_origin: 'enum', preset_name: null };
  }

  // 2. Boolean
  if (record.json_type === 'boolean') {
    return { value_origin: 'boolean', preset_name: null };
  }

  // 3. Per-block / per-element styles paths — look at the normalised tail
  const stylesKey = normalizeStylesPath(record.path);
  if (stylesKey) {
    const cssProp = pathToCss.get(stylesKey);
    if (cssProp) {
      // Preset consumer?
      const presetName = cssPropToPreset.get(cssProp);
      if (presetName) {
        return { value_origin: `preset_ref:${presetName}`, preset_name: presetName };
      }
      // CSS bucket
      if (CSS_COLOR_PROPS.has(cssProp)) return { value_origin: 'css_color', preset_name: null };
      if (CSS_LENGTH_PROPS.has(cssProp)) return { value_origin: 'css_length', preset_name: null };
      if (cssProp in CSS_KEYWORD_PROPS_TO_KEYWORDS) return { value_origin: 'css_keyword', preset_name: null };
    }
  }

  // 4. settings.* preset producers (color.palette, typography.fontSizes, etc)
  if (record.path.startsWith('settings.')) {
    const tail = record.path.slice('settings.'.length).replace(/^blocks\.\{block-name\}\./, '');
    if (PRESET_NAME_BY_PATH_KEY[tail]) {
      return { value_origin: 'array', preset_name: PRESET_NAME_BY_PATH_KEY[tail] };
    }
  }

  // 5. Fall through to JSON-Schema type
  if (record.json_type === 'array') return { value_origin: 'array', preset_name: null };
  if (record.json_type === 'object') return { value_origin: 'object', preset_name: null };
  if (record.json_type === 'integer' || record.json_type === 'number') return { value_origin: 'number', preset_name: null };
  return { value_origin: 'string', preset_name: null };
}

/**
 * Merge schema records + class constants into final property records, plus preset rows
 * and alias rows.
 *
 * @param {Array} schemaRecords - From parseSchema()
 * @param {object} classConstants - From extractClassConstants() — any field may be undefined
 * @returns {{ properties: Array, presets: Array }}
 */
export function mergeRecords(schemaRecords, classConstants) {
  const presetsMetadata = classConstants.PRESETS_METADATA;
  const propertiesMetadata = classConstants.PROPERTIES_METADATA;
  const indirectProperties = classConstants.INDIRECT_PROPERTIES_METADATA;

  const cssPropToPreset = buildCssPropertyToPresetMap(presetsMetadata);
  const pathToCss = buildPathToCssMap(propertiesMetadata);
  const ctx = { cssPropToPreset, pathToCss };

  // Build the set of "confirmed by class" paths (settings.X.Y, styles.X.Y where the class
  // parser saw them). Used to flag confirmed_by='both' vs 'schema'.
  const classPaths = new Set();
  collectClassPaths(classConstants.VALID_SETTINGS, 'settings', classPaths);
  collectClassPaths(classConstants.VALID_STYLES, 'styles', classPaths);

  const properties = [];

  for (const r of schemaRecords) {
    const { value_origin, preset_name } = classifyValueOrigin(r, ctx);
    const confirmedBy = classPaths.has(r.path) ? 'both' : 'schema';
    properties.push({
      path: r.path,
      parent_context: r.parent_context,
      scope: r.scope,
      json_type: r.json_type || null,
      value_origin,
      enum_values: r.enum ? JSON.stringify(r.enum) : null,
      description: r.description || null,
      since: extractSinceFromDescription(r.description),
      confirmed_by: confirmedBy,
      preset_name,
      schema_ref: r.schema_ref || null,
    });
  }

  // Add alias rows for INDIRECT_PROPERTIES_METADATA — e.g. `gap` → `styles.spacing.blockGap`
  if (indirectProperties && typeof indirectProperties === 'object') {
    for (const [cssProp, targets] of Object.entries(indirectProperties)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const targetPath = `styles.${targets[0].join('.')}`;
      properties.push({
        path: `alias:${cssProp}`,
        parent_context: 'alias',
        scope: 'global',
        json_type: null,
        value_origin: 'alias',
        enum_values: null,
        description: `CSS property "${cssProp}" maps to theme.json path "${targetPath}"${targets.length > 1 ? ` (also: ${targets.slice(1).map(t => 'styles.' + t.join('.')).join(', ')})` : ''}.`,
        since: null,
        confirmed_by: 'class',
        preset_name: null,
        schema_ref: targetPath,
      });
    }
  }

  // Build preset rows from PRESETS_METADATA
  const presets = [];
  if (Array.isArray(presetsMetadata)) {
    for (const preset of presetsMetadata) {
      const pathKey = Array.isArray(preset.path) ? preset.path.join('.') : '';
      const presetName = PRESET_NAME_BY_PATH_KEY[pathKey];
      if (!presetName) continue;
      presets.push({
        preset_name: presetName,
        settings_path: `settings.${pathKey}`,
        css_var_template: preset.css_vars || null,
        value_key: preset.value_key || null,
        css_properties: JSON.stringify(preset.properties || []),
      });
    }
  }

  return { properties, presets };
}

/**
 * Recursively walk VALID_SETTINGS / VALID_STYLES to collect every valid path under that
 * prefix. The constants are nested objects where values are either `null` (leaf) or
 * another nested object (branch).
 */
function collectClassPaths(node, prefix, out) {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const path = `${prefix}.${key}`;
    out.add(path);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectClassPaths(value, path, out);
    }
  }
}

/**
 * Extract a `since` version from a description like "Since 6.5.0..." or matching the
 * first version-looking token. Returns null if none found.
 */
function extractSinceFromDescription(desc) {
  if (!desc) return null;
  const m = desc.match(/(?:since|added in)\s+(\d+\.\d+(?:\.\d+)?)/i);
  return m ? m[1] : null;
}
