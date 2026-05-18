/**
 * Extracts targeted constants from WordPress's class-wp-theme-json.php.
 *
 * The constants we read (VALID_SETTINGS, VALID_STYLES, PRESETS_METADATA, PROPERTIES_METADATA,
 * INDIRECT_PROPERTIES_METADATA, VALID_ELEMENT_PSEUDO_SELECTORS, VALID_BLOCK_PSEUDO_SELECTORS)
 * are pure PHP-array literals — strings, null/true/false, numbers, and nested arrays. No
 * function calls, no concatenation, no self:: references. That lets us convert them with a
 * small recursive parser without depending on a real PHP runtime.
 *
 * Each constant is extracted independently with try/catch so a future incompatibility in one
 * doesn't poison the others. The merge step degrades gracefully when a constant is missing.
 */

const CONSTANT_NAMES = [
  'VALID_TOP_LEVEL_KEYS',
  'VALID_SETTINGS',
  'VALID_STYLES',
  'PRESETS_METADATA',
  'PROPERTIES_METADATA',
  'INDIRECT_PROPERTIES_METADATA',
  'VALID_ELEMENT_PSEUDO_SELECTORS',
  'VALID_BLOCK_PSEUDO_SELECTORS',
];

/**
 * Parse a PHP array literal starting at offset `start` in `src` (which must point at the
 * opening `array(`). Returns { value, end } where `end` is the offset after the closing `)`.
 */
class PhpLiteralReader {
  constructor(src, start) {
    this.src = src;
    this.pos = start;
  }

  peek() { return this.src[this.pos]; }
  eof() { return this.pos >= this.src.length; }

  skipWhitespaceAndComments() {
    while (!this.eof()) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
      } else if (this.src.startsWith('//', this.pos)) {
        while (!this.eof() && this.src[this.pos] !== '\n') this.pos++;
      } else if (this.src.startsWith('/*', this.pos)) {
        this.pos += 2;
        while (!this.eof() && !this.src.startsWith('*/', this.pos)) this.pos++;
        if (!this.eof()) this.pos += 2;
      } else {
        break;
      }
    }
  }

  readString() {
    const quote = this.src[this.pos];
    if (quote !== "'" && quote !== '"') {
      throw new Error(`Expected string at offset ${this.pos}`);
    }
    this.pos++;
    let out = '';
    while (!this.eof()) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        if (quote === "'") {
          if (next === '\\' || next === "'") {
            out += next;
            this.pos += 2;
            continue;
          }
          out += ch;
          this.pos++;
          continue;
        }
        // double-quoted
        switch (next) {
          case 'n': out += '\n'; this.pos += 2; continue;
          case 't': out += '\t'; this.pos += 2; continue;
          case 'r': out += '\r'; this.pos += 2; continue;
          case '\\': out += '\\'; this.pos += 2; continue;
          case '"': out += '"'; this.pos += 2; continue;
          case '$': out += '$'; this.pos += 2; continue;
          default: out += next; this.pos += 2; continue;
        }
      }
      if (ch === quote) {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    throw new Error('Unterminated string');
  }

  readBareWord() {
    const start = this.pos;
    while (!this.eof() && /[A-Za-z0-9_]/.test(this.src[this.pos])) this.pos++;
    return this.src.slice(start, this.pos);
  }

  readNumber() {
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos++;
    while (!this.eof() && /[0-9.]/.test(this.src[this.pos])) this.pos++;
    return Number(this.src.slice(start, this.pos));
  }

  readValue() {
    this.skipWhitespaceAndComments();
    const ch = this.src[this.pos];
    if (ch === "'" || ch === '"') return this.readString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.readNumber();
    if (this.src.startsWith('array', this.pos)) {
      this.pos += 5;
      this.skipWhitespaceAndComments();
      if (this.src[this.pos] !== '(') throw new Error(`Expected '(' after array at ${this.pos}`);
      this.pos++;
      return this.readArrayBody(')');
    }
    if (this.src[this.pos] === '[') {
      this.pos++;
      return this.readArrayBody(']');
    }
    // bare word: null / true / false
    const word = this.readBareWord();
    if (word === 'null') return null;
    if (word === 'true') return true;
    if (word === 'false') return false;
    throw new Error(`Unexpected token "${word}" at offset ${this.pos}`);
  }

  readArrayBody(closer) {
    const entries = []; // { key?, value }
    let hasKeyed = false;
    let hasUnkeyed = false;

    while (true) {
      this.skipWhitespaceAndComments();
      if (this.src[this.pos] === closer) {
        this.pos++;
        break;
      }

      const firstValue = this.readValue();
      this.skipWhitespaceAndComments();

      if (this.src.startsWith('=>', this.pos)) {
        this.pos += 2;
        const v = this.readValue();
        entries.push({ key: firstValue, value: v });
        hasKeyed = true;
      } else {
        entries.push({ value: firstValue });
        hasUnkeyed = true;
      }

      this.skipWhitespaceAndComments();
      if (this.src[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.src[this.pos] === closer) {
        this.pos++;
        break;
      }
      throw new Error(`Expected ',' or '${closer}' at offset ${this.pos}`);
    }

    if (hasKeyed && !hasUnkeyed) {
      const obj = {};
      for (const e of entries) obj[String(e.key)] = e.value;
      return obj;
    }
    return entries.map(e => e.value);
  }
}

/**
 * Extract one constant by name. Returns the parsed JS value or undefined on failure.
 */
function extractOne(src, name) {
  const re = new RegExp(`\\bconst\\s+${name}\\s*=\\s*array\\s*\\(`, 'm');
  const match = re.exec(src);
  if (!match) return undefined;
  const startOfBody = match.index + match[0].length;
  try {
    const reader = new PhpLiteralReader(src, startOfBody);
    const value = reader.readArrayBody(')');
    return value;
  } catch (err) {
    console.error(`[theme-json] Failed to parse ${name}: ${err.message}`);
    return undefined;
  }
}

/**
 * Parse class-wp-theme-json.php source and return the extracted constants.
 * Each missing/failed constant comes back as undefined — callers handle that.
 *
 * @param {string} src - PHP source code
 * @returns {Record<string, any>}
 */
export function extractClassConstants(src) {
  const out = {};
  for (const name of CONSTANT_NAMES) {
    out[name] = extractOne(src, name);
  }
  return out;
}

export { PhpLiteralReader };
