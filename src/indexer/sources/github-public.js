import { join } from 'node:path';
import { existsSync } from 'node:fs';
import simpleGit from 'simple-git';
import { CACHE_DIR } from '../../constants.js';
import { mkdirSync } from 'node:fs';

/**
 * Fetch a public GitHub repo via shallow clone / pull.
 * Returns the local path to the (optionally subfoldered) source.
 */
export async function fetchGithubPublic(source) {
  const repoName = source.repo_url.replace(/.*\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/\//g, '--');
  const cloneDir = join(CACHE_DIR, repoName);
  mkdirSync(CACHE_DIR, { recursive: true });

  const git = simpleGit();

  if (existsSync(join(cloneDir, '.git'))) {
    // Pull latest
    const repoGit = simpleGit(cloneDir);
    try {
      await repoGit.fetch('origin', source.branch || 'main', ['--depth=1']);
      await repoGit.reset(['--hard', `origin/${source.branch || 'main'}`]);
    } catch (err) {
      console.error(`Warning: pull failed for ${source.name}, using cached version: ${err.message}`);
    }
  } else {
    // Shallow clone
    await git.clone(source.repo_url, cloneDir, [
      '--depth=1',
      '--branch', source.branch || 'main',
      '--single-branch',
    ]);
  }

  const localPath = source.subfolder ? join(cloneDir, source.subfolder) : cloneDir;
  return localPath;
}
