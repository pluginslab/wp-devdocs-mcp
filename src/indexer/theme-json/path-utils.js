/**
 * Shared helpers for theme.json path handling. Used by the MCP tool handler and the CLI.
 */

export const KNOWN_ELEMENTS = new Set([
  'link', 'heading', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'button', 'caption', 'cite', 'textInput', 'select',
]);

/**
 * Normalise a real per-block/per-element path to the placeholder form used in the index.
 *
 *   styles.blocks.core/paragraph.color.text → styles.blocks.{block-name}.color.text
 *   settings.blocks.core/heading.typography.fontSize → settings.blocks.{block-name}.typography.fontSize
 *   styles.elements.button.color.text → styles.elements.{element-name}.color.text
 *
 * Returns the normalised path plus the captured block/element names so callers can
 * cross-reference (e.g. flag unknown blocks).
 */
export function normalisePath(path) {
  const blockMatch = path.match(/^(styles|settings)\.blocks\.([a-z0-9-]+\/[a-z0-9-]+)(\..*)?$/);
  if (blockMatch) {
    return {
      normalised: `${blockMatch[1]}.blocks.{block-name}${blockMatch[3] || ''}`,
      blockName: blockMatch[2],
      elementName: null,
    };
  }
  const elementMatch = path.match(/^styles\.elements\.([a-zA-Z][a-zA-Z0-9]*)(\..*)?$/);
  if (elementMatch) {
    return {
      normalised: `styles.elements.{element-name}${elementMatch[2] || ''}`,
      blockName: null,
      elementName: elementMatch[1],
    };
  }
  return { normalised: path, blockName: null, elementName: null };
}
