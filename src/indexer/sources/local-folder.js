import { existsSync } from 'node:fs';

/**
 * Validate and return a local folder path.
 */
export async function fetchLocalFolder(source) {
  const localPath = source.local_path;
  if (!localPath) {
    throw new Error(`Source "${source.name}" is type local-folder but has no local_path configured`);
  }

  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`);
  }

  return localPath;
}
