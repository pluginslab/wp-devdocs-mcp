import { BaseDocParser } from './base-doc-parser.js';

export class AdminHandbookParser extends BaseDocParser {
  canParse(filePath, frontmatter, sourceName) {
    return sourceName.includes('admin');
  }

  parse(content, filePath, sourceId) {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const title = this.extractTitle(body, frontmatter) || filePath;
    const description = this.extractDescription(body);
    const codeExamples = this.extractCodeExamples(body);

    const pathParts = filePath.split('/');
    const subcategory = pathParts.length > 1 ? pathParts[0] : null;

    // Extract config snippets (wp-config.php defines, .htaccess, nginx)
    const configSnippets = [];
    const defineRegex = /define\s*\(\s*['"](\w+)['"]/g;
    let match;
    while ((match = defineRegex.exec(body)) !== null) {
      if (!configSnippets.includes(match[1])) {
        configSnippets.push(match[1]);
      }
    }

    const metadata = {};
    if (configSnippets.length > 0) metadata.config_defines = configSnippets;
    if (Object.keys(frontmatter).length > 0) metadata.frontmatter = frontmatter;

    const doc = {
      source_id: sourceId,
      file_path: filePath,
      slug: this.generateSlug(filePath),
      title,
      doc_type: this.inferDocType(body, frontmatter),
      category: 'admin',
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
