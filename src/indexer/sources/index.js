import { fetchGithubPublic } from './github-public.js';
import { fetchGithubPrivate } from './github-private.js';
import { fetchLocalFolder } from './local-folder.js';

/**
 * Unified dispatcher — fetches/validates a source and returns the local path.
 */
export async function fetchSource(source) {
  switch (source.type) {
    case 'github-public':
      return fetchGithubPublic(source);
    case 'github-private':
      return fetchGithubPrivate(source);
    case 'local-folder':
      return fetchLocalFolder(source);
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
}
