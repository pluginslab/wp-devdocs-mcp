export const PRESETS = {
  'wp-core': {
    name: 'wp-core',
    type: 'github-public',
    repo_url: 'https://github.com/WordPress/wordpress-develop.git',
    branch: 'trunk',
    content_type: 'source',
  },
  'gutenberg-source': {
    name: 'gutenberg-source',
    type: 'github-public',
    repo_url: 'https://github.com/WordPress/gutenberg.git',
    branch: 'trunk',
    content_type: 'source',
  },
  'gutenberg-docs': {
    name: 'gutenberg-docs',
    type: 'github-public',
    repo_url: 'https://github.com/WordPress/gutenberg.git',
    subfolder: 'docs',
    branch: 'trunk',
    content_type: 'docs',
  },
  'plugin-handbook': {
    name: 'plugin-handbook',
    type: 'github-public',
    repo_url: 'https://github.com/WordPress/developer-plugins-handbook.git',
    branch: 'main',
    content_type: 'docs',
  },
  'rest-api-handbook': {
    name: 'rest-api-handbook',
    type: 'github-public',
    repo_url: 'https://github.com/WP-API/docs.git',
    branch: 'master',
    content_type: 'docs',
  },
  'wp-cli-handbook': {
    name: 'wp-cli-handbook',
    type: 'github-public',
    repo_url: 'https://github.com/wp-cli/handbook.git',
    branch: 'main',
    content_type: 'docs',
  },
  'admin-handbook': {
    name: 'admin-handbook',
    type: 'github-public',
    repo_url: 'https://github.com/WordPress/Advanced-administration-handbook.git',
    branch: 'main',
    content_type: 'docs',
  },
  'woocommerce': {
    name: 'woocommerce',
    type: 'github-public',
    repo_url: 'https://github.com/woocommerce/woocommerce.git',
    subfolder: 'plugins/woocommerce',
    branch: 'trunk',
    content_type: 'source',
  },
};

export function getPreset(name) {
  return PRESETS[name] || null;
}

export function listPresets() {
  return Object.values(PRESETS);
}
