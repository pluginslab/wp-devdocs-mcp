import { createHash } from 'node:crypto';

/**
 * Base class for document parsers. Each parser handles a specific type of
 * WordPress documentation (handbook, REST API reference, WP-CLI, etc.).
 */
export class BaseDocParser {
  /**
   * Check if this parser can handle the given file.
   * @param {string} filePath - Relative file path
   * @param {object} frontmatter - Parsed frontmatter data
   * @param {string} sourceName - The source name from DB
   * @returns {boolean}
   */
  canParse(filePath, frontmatter, sourceName) {
    throw new Error('canParse() must be implemented by subclass');
  }

  /**
   * Parse a markdown file into a structured doc object.
   * @param {string} content - Raw file content
   * @param {string} filePath - Relative file path
   * @param {number} sourceId - Source ID from DB
   * @returns {object} Parsed doc data ready for upsertDoc()
   */
  parse(content, filePath, sourceId) {
    throw new Error('parse() must be implemented by subclass');
  }

  // --- Shared utilities ---

  extractFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { frontmatter: {}, body: content };

    const raw = match[1];
    const frontmatter = {};
    for (const line of raw.split('\n')) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const val = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
      if (key) frontmatter[key] = val;
    }

    const body = content.slice(match[0].length).trim();
    return { frontmatter, body };
  }

  extractTitle(body, frontmatter) {
    if (frontmatter.title) return frontmatter.title;
    const h1 = body.match(/^#\s+(.+)/m);
    if (h1) return h1[1].trim();
    return null;
  }

  extractDescription(body) {
    // First non-heading, non-empty paragraph
    const lines = body.split('\n');
    let collecting = false;
    const desc = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (collecting) break;
        continue;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('```')) {
        if (collecting) break;
        continue;
      }
      collecting = true;
      desc.push(trimmed);
    }

    const result = desc.join(' ').slice(0, 500);
    return result || null;
  }

  extractCodeExamples(body) {
    const examples = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
      examples.push({
        language: match[1] || 'text',
        code: match[2].trim(),
      });
    }
    return examples.length > 0 ? JSON.stringify(examples) : null;
  }

  generateSlug(filePath) {
    return filePath
      .toLowerCase()
      .replace(/\.md$/i, '')
      .replace(/\\/g, '/')
      .replace(/[^a-z0-9/_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/\//g, '--')
      .replace(/^-|-$/g, '');
  }

  generateContentHash(data) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify({
      title: data.title,
      content: data.content,
      doc_type: data.doc_type,
      category: data.category,
    }));
    return hash.digest('hex').slice(0, 16);
  }

  inferDocType(body, frontmatter) {
    const text = (body + ' ' + (frontmatter.title || '')).toLowerCase();

    if (frontmatter.doc_type) return frontmatter.doc_type;

    if (/\breference\b/.test(text) || /\bapi\b/.test(text)) return 'reference';
    if (/\btutorial\b/.test(text) || /\bstep[- ]by[- ]step\b/.test(text)) return 'tutorial';
    if (/\bhow[- ]to\b/.test(text)) return 'howto';
    if (/\bfaq\b/i.test(text) || /\bfrequently asked\b/.test(text)) return 'faq';
    if (/\bguide\b/.test(text)) return 'guide';

    return 'general';
  }
}

/**
 * Registry that selects the appropriate parser for a given file.
 * Parsers are checked in order — first match wins.
 */
export class DocParserRegistry {
  constructor() {
    this.parsers = [];
  }

  register(parser) {
    this.parsers.push(parser);
  }

  getParser(filePath, frontmatter, sourceName) {
    for (const parser of this.parsers) {
      if (parser.canParse(filePath, frontmatter, sourceName)) {
        return parser;
      }
    }
    return null;
  }
}
