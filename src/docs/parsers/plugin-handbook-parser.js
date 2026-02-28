import { BaseDocParser } from './base-doc-parser.js';

export class PluginHandbookParser extends BaseDocParser {
  canParse(filePath, frontmatter, sourceName) {
    return sourceName.includes('plugin-handbook') || sourceName === 'plugin';
  }

  parse(content, filePath, sourceId) {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const title = this.extractTitle(body, frontmatter) || filePath;
    const description = this.extractDescription(body);
    const codeExamples = this.extractCodeExamples(body);

    // Infer subcategory from directory structure
    const pathParts = filePath.split('/');
    const subcategory = pathParts.length > 1 ? pathParts[0] : null;

    // Extract WP function references
    const funcRefs = [];
    const funcRegex = /\b(wp_\w+|get_\w+|add_\w+|remove_\w+|do_action|apply_filters|register_\w+)\s*\(/g;
    let match;
    while ((match = funcRegex.exec(body)) !== null) {
      if (!funcRefs.includes(match[1])) {
        funcRefs.push(match[1]);
      }
    }

    // Extract hook names mentioned in content
    const hookRefs = [];
    const hookRegex = /['"`]([a-z_]+(?:\{[^}]*\})?[a-z_]*)['"`]\s*(?:,|\))/g;
    while ((match = hookRegex.exec(body)) !== null) {
      const name = match[1];
      if (name.includes('_') && name.length > 3 && !hookRefs.includes(name)) {
        hookRefs.push(name);
      }
    }

    const metadata = {};
    if (funcRefs.length > 0) metadata.function_refs = funcRefs;
    if (hookRefs.length > 0) metadata.hook_refs = hookRefs;
    if (Object.keys(frontmatter).length > 0) metadata.frontmatter = frontmatter;

    const doc = {
      source_id: sourceId,
      file_path: filePath,
      slug: this.generateSlug(filePath),
      title,
      doc_type: this.inferDocType(body, frontmatter),
      category: 'plugins',
      subcategory,
      description,
      content: body,
      code_examples: codeExamples,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
    };

    doc.content_hash = this.generateContentHash(doc);
    return doc;
  }
}
