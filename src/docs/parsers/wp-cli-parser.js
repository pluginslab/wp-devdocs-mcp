import { BaseDocParser } from './base-doc-parser.js';

export class WpCliParser extends BaseDocParser {
  canParse(filePath, frontmatter, sourceName) {
    return sourceName.includes('wp-cli');
  }

  parse(content, filePath, sourceId) {
    const { frontmatter, body } = this.extractFrontmatter(content);
    const title = this.extractTitle(body, frontmatter) || filePath;
    const description = this.extractDescription(body);
    const codeExamples = this.extractCodeExamples(body);

    const pathParts = filePath.split('/');
    const subcategory = pathParts.length > 1 ? pathParts[0] : null;

    // Extract command signatures like "wp <command> <subcommand> [--flag]"
    const commands = [];
    const cmdRegex = /(?:^|\n)\s*(?:#+\s*)?`?(wp\s+[\w-]+(?:\s+[\w-]+)?)`?/g;
    let match;
    while ((match = cmdRegex.exec(body)) !== null) {
      const cmd = match[1].trim();
      if (!commands.includes(cmd)) {
        commands.push(cmd);
      }
    }

    // Extract options/flags like --option=<value>
    const options = [];
    const optRegex = /--[\w-]+(?:=<[^>]+>)?/g;
    while ((match = optRegex.exec(body)) !== null) {
      if (!options.includes(match[0])) {
        options.push(match[0]);
      }
    }

    const metadata = {};
    if (commands.length > 0) metadata.commands = commands;
    if (options.length > 0) metadata.options = options;
    if (Object.keys(frontmatter).length > 0) metadata.frontmatter = frontmatter;

    const docType = commands.length > 0 ? 'reference' : this.inferDocType(body, frontmatter);

    const doc = {
      source_id: sourceId,
      file_path: filePath,
      slug: this.generateSlug(filePath),
      title,
      doc_type: docType,
      category: 'wp-cli',
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
