import { join } from 'node:path';
import { homedir } from 'node:os';

export const BASE_DIR = join(homedir(), '.wp-devdocs-mcp');
export const DB_PATH = join(BASE_DIR, 'hooks.db');
export const CACHE_DIR = join(BASE_DIR, 'cache');
export const SOURCES_DIR = join(BASE_DIR, 'sources');

export const DOC_TYPES = {
  GUIDE: 'guide',
  TUTORIAL: 'tutorial',
  REFERENCE: 'reference',
  API: 'api',
  HOWTO: 'howto',
  FAQ: 'faq',
  GENERAL: 'general',
};

export const CONTENT_TYPES = {
  SOURCE: 'source',
  DOCS: 'docs',
};
