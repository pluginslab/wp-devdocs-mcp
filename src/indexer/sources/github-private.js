import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import simpleGit from 'simple-git';
import { CACHE_DIR } from '../../constants.js';

/**
 * Fetch a private GitHub repo using a token from an env var.
 * Token is injected into the URL at clone time — never stored.
 */
export async function fetchGithubPrivate(source) {
  const tokenEnvVar = source.token_env_var;
  if (!tokenEnvVar) {
    throw new Error(`Source "${source.name}" is type github-private but has no token_env_var configured`);
  }

  const token = process.env[tokenEnvVar];
  if (!token) {
    throw new Error(`Environment variable "${tokenEnvVar}" is not set. Required for private repo "${source.name}"`);
  }

  const repoName = source.repo_url.replace(/.*\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/\//g, '--');
  const cloneDir = join(CACHE_DIR, repoName);
  mkdirSync(CACHE_DIR, { recursive: true });

  // Inject token into URL: https://token@github.com/...
  const authedUrl = source.repo_url.replace('https://', `https://${token}@`);

  const git = simpleGit();

  if (existsSync(join(cloneDir, '.git'))) {
    const repoGit = simpleGit(cloneDir);
    try {
      // Set remote URL with token temporarily for fetch
      await repoGit.remote(['set-url', 'origin', authedUrl]);
      await repoGit.fetch('origin', source.branch || 'main', ['--depth=1']);
      await repoGit.reset(['--hard', `origin/${source.branch || 'main'}`]);
      // Remove token from stored remote
      await repoGit.remote(['set-url', 'origin', source.repo_url]);
    } catch (err) {
      // Clean up token from remote even on error
      try { await repoGit.remote(['set-url', 'origin', source.repo_url]); } catch (_) { /* token cleanup is best-effort */ }
      console.error(`Warning: pull failed for ${source.name}: ${err.message}`);
    }
  } else {
    await git.clone(authedUrl, cloneDir, [
      '--depth=1',
      '--branch', source.branch || 'main',
      '--single-branch',
    ]);
    // Remove token from stored remote
    const repoGit = simpleGit(cloneDir);
    await repoGit.remote(['set-url', 'origin', source.repo_url]);
  }

  const localPath = source.subfolder ? join(cloneDir, source.subfolder) : cloneDir;
  return localPath;
}
