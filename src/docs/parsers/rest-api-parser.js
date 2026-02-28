import { BaseDocParser } from './base-doc-parser.js';

export class RestApiParser extends BaseDocParser {
  canParse(filePath, frontmatter, sourceName) {
    return sourceName.includes('rest-api') || sourceName.includes('wp-api');
  }

  parse(content, filePath, sourceId) {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const title = this.extractTitle(body, frontmatter) || filePath;
    const description = this.extractDescription(body);
    const codeExamples = this.extractCodeExamples(body);

    const pathParts = filePath.split('/');
    const subcategory = pathParts.length > 1 ? pathParts[0] : null;

    // Extract endpoint definitions (method + route)
    const endpoints = [];
    const endpointRegex = /\b(GET|POST|PUT|PATCH|DELETE)\s+(`?\/wp\/v2\/[\w\/-{}]+`?|`?\/wp-json\/[\w\/-{}]+`?)/g;
    let match;
    while ((match = endpointRegex.exec(body)) !== null) {
      endpoints.push({ method: match[1], route: match[2].replace(/`/g, '') });
    }

    // Also look for route definitions in code blocks
    const routeRegex = /['"]\/wp\/v2\/[\w\/-{}]+['"]/g;
    while ((match = routeRegex.exec(body)) !== null) {
      const route = match[0].replace(/['"]/g, '');
      if (!endpoints.find(e => e.route === route)) {
        endpoints.push({ method: 'ANY', route });
      }
    }

    const metadata = {};
    if (endpoints.length > 0) metadata.endpoints = endpoints;
    if (Object.keys(frontmatter).length > 0) metadata.frontmatter = frontmatter;

    const docType = endpoints.length > 0 ? 'api' : this.inferDocType(body, frontmatter);

    const doc = {
      source_id: sourceId,
      file_path: filePath,
      slug: this.generateSlug(filePath),
      title,
      doc_type: docType,
      category: 'rest-api',
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
