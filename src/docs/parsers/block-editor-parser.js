import { BaseDocParser } from './base-doc-parser.js';

export class BlockEditorParser extends BaseDocParser {
  canParse(filePath, frontmatter, sourceName) {
    return sourceName.includes('gutenberg') && filePath.startsWith('docs/');
  }

  parse(content, filePath, sourceId) {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const title = this.extractTitle(body, frontmatter) || filePath;
    const description = this.extractDescription(body);
    const codeExamples = this.extractCodeExamples(body);

    // Infer subcategory from path: docs/getting-started/..., docs/reference-guides/..., etc.
    const pathParts = filePath.split('/');
    const subcategory = pathParts.length > 2 ? pathParts[1] : null;

    // Extract @wordpress/ package references
    const packageRefs = [];
    const pkgRegex = /@wordpress\/[\w-]+/g;
    let match;
    while ((match = pkgRegex.exec(body)) !== null) {
      if (!packageRefs.includes(match[0])) {
        packageRefs.push(match[0]);
      }
    }

    const metadata = {};
    if (packageRefs.length > 0) metadata.package_refs = packageRefs;
    if (Object.keys(frontmatter).length > 0) metadata.frontmatter = frontmatter;

    const doc = {
      source_id: sourceId,
      file_path: filePath,
      slug: this.generateSlug(filePath),
      title,
      doc_type: this.inferDocType(body, frontmatter),
      category: 'block-editor',
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
