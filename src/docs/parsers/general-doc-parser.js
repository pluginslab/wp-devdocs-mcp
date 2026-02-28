import { BaseDocParser } from './base-doc-parser.js';

/**
 * Fallback parser for any markdown doc that doesn't match a specialized parser.
 * Always returns true from canParse() — must be registered last in the registry.
 */
export class GeneralDocParser extends BaseDocParser {
  canParse() {
    return true;
  }

  parse(content, filePath, sourceId) {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const title = this.extractTitle(body, frontmatter) || filePath;
    const description = this.extractDescription(body);
    const codeExamples = this.extractCodeExamples(body);

    const pathParts = filePath.split('/');
    const subcategory = pathParts.length > 1 ? pathParts[0] : null;

    // Try to infer category from path or frontmatter
    let category = frontmatter.category || null;
    if (!category) {
      const pathLower = filePath.toLowerCase();
      if (pathLower.includes('block') || pathLower.includes('gutenberg')) category = 'block-editor';
      else if (pathLower.includes('plugin')) category = 'plugins';
      else if (pathLower.includes('rest') || pathLower.includes('api')) category = 'rest-api';
      else if (pathLower.includes('cli')) category = 'wp-cli';
      else if (pathLower.includes('admin')) category = 'admin';
    }

    const metadata = Object.keys(frontmatter).length > 0
      ? JSON.stringify({ frontmatter })
      : null;

    const doc = {
      source_id: sourceId,
      file_path: filePath,
      slug: this.generateSlug(filePath),
      title,
      doc_type: this.inferDocType(body, frontmatter),
      category,
      subcategory,
      description,
      content: body,
      code_examples: codeExamples,
      metadata,
    };

    doc.content_hash = this.generateContentHash(doc);
    return doc;
  }
}
