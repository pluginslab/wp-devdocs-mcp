import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  getSource,
  upsertThemeJsonProperty,
  upsertThemeJsonPreset,
  markThemeJsonPropertiesRemoved,
} from '../../db/sqlite.js';
import { CACHE_DIR } from '../../constants.js';
import { parseSchema } from './schema-parser.js';
import { extractClassConstants } from './class-constants-parser.js';
import { mergeRecords } from './merge.js';

const SCHEMA_REL_PATH = 'schemas/json/theme.json';
const CLASS_REL_PATH = 'src/wp-includes/class-wp-theme-json.php';
const WP_CORE_SOURCE_NAME = 'wp-core';

/**
 * Derive the cache directory a github-public source would clone into.
 * Mirrors fetchGithubPublic's naming convention so we can find a sibling source
 * (wp-core) without re-fetching it.
 */
function deriveGithubCachePath(repoUrl) {
  if (!repoUrl) return null;
  const repoName = repoUrl.replace(/.*\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/\//g, '--');
  return join(CACHE_DIR, repoName);
}

/**
 * Index theme.json properties from the Gutenberg schema, optionally enriched with the
 * VALID_SETTINGS / VALID_STYLES / PRESETS_METADATA constants from wp-core.
 *
 * Soft-degrades when the wp-core source is not yet indexed — schema-only data is still
 * useful, just without preset_ref classification or `confirmed_by='both'` flags.
 */
export async function indexThemeJsonSource(source, localPath, force, stats) {
  const schemaPath = join(localPath, SCHEMA_REL_PATH);
  if (!existsSync(schemaPath)) {
    throw new Error(`theme.json schema not found at ${schemaPath} — expected Gutenberg source`);
  }

  const schemaContent = readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaContent);

  // Try to enrich with class constants from wp-core (soft-degrade if missing)
  let classConstants = {};
  const wpCore = getSource(WP_CORE_SOURCE_NAME);
  if (wpCore) {
    const wpCorePath = wpCore.local_path || deriveGithubCachePath(wpCore.repo_url);
    const classPath = wpCorePath ? join(wpCorePath, CLASS_REL_PATH) : null;
    if (classPath && existsSync(classPath)) {
      const phpSrc = readFileSync(classPath, 'utf-8');
      classConstants = extractClassConstants(phpSrc);
    } else {
      console.error(`[theme-json] wp-core source present but class file not found at ${classPath} — proceeding with schema only`);
    }
  } else {
    console.error('[theme-json] wp-core source not indexed — proceeding with schema-only data. Run: wp-hooks quick-add wp-core for full preset_ref classification.');
  }

  const schemaRecords = parseSchema(schema);
  const { properties, presets } = mergeRecords(schemaRecords, classConstants);

  console.error(`[theme-json] Parsed ${schemaRecords.length} schema paths, ${properties.length} merged properties, ${presets.length} presets`);

  const activeIds = [];

  for (const p of properties) {
    const contentHash = createHash('sha256').update(JSON.stringify({
      path: p.path,
      value_origin: p.value_origin,
      enum_values: p.enum_values,
      description: p.description,
      confirmed_by: p.confirmed_by,
    })).digest('hex').slice(0, 16);

    const result = upsertThemeJsonProperty({
      source_id: source.id,
      path: p.path,
      parent_context: p.parent_context,
      scope: p.scope,
      json_type: p.json_type,
      value_origin: p.value_origin,
      enum_values: p.enum_values,
      description: p.description,
      since: p.since,
      confirmed_by: p.confirmed_by,
      preset_name: p.preset_name,
      schema_ref: p.schema_ref,
      content_hash: contentHash,
    });
    activeIds.push(result.id);

    if (result.action === 'inserted') stats.theme_json_properties_inserted++;
    else if (result.action === 'updated') stats.theme_json_properties_updated++;
    else stats.theme_json_properties_skipped++;
  }

  for (const preset of presets) {
    upsertThemeJsonPreset({
      source_id: source.id,
      preset_name: preset.preset_name,
      settings_path: preset.settings_path,
      css_var_template: preset.css_var_template,
      value_key: preset.value_key,
      css_properties: preset.css_properties,
    });
    stats.theme_json_presets_indexed++;
  }

  // Soft-delete any properties that disappeared between runs
  const removed = markThemeJsonPropertiesRemoved(source.id, activeIds);
  stats.theme_json_properties_removed += removed;

  // Use force to mark whether class data is available (informational)
  if (force) {
    // No special behaviour today; reserved for future re-fetch logic
  }
}
