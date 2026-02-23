import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from '../constants.js';

let db;

export function getDb() {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initDb(db);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      repo_url TEXT,
      subfolder TEXT,
      local_path TEXT,
      token_env_var TEXT,
      branch TEXT DEFAULT 'main',
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS hooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      php_function TEXT,
      params TEXT,
      param_count INTEGER DEFAULT 0,
      docblock TEXT,
      inferred_description TEXT,
      function_context TEXT,
      class_name TEXT,
      code_before TEXT,
      code_after TEXT,
      hook_line TEXT,
      is_dynamic INTEGER DEFAULT 0,
      content_hash TEXT,
      status TEXT DEFAULT 'active',
      removed_at TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, file_path, line_number, name)
    );

    CREATE INDEX IF NOT EXISTS idx_hooks_source_id ON hooks(source_id);
    CREATE INDEX IF NOT EXISTS idx_hooks_name ON hooks(name);
    CREATE INDEX IF NOT EXISTS idx_hooks_type ON hooks(type);
    CREATE INDEX IF NOT EXISTS idx_hooks_status ON hooks(status);
    CREATE INDEX IF NOT EXISTS idx_hooks_source_status ON hooks(source_id, status);

    CREATE VIRTUAL TABLE IF NOT EXISTS hooks_fts USING fts5(
      name,
      type,
      docblock,
      inferred_description,
      function_context,
      class_name,
      params,
      content='hooks',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS indexed_files (
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      mtime_ms REAL,
      content_hash TEXT,
      UNIQUE(source_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS block_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      block_name TEXT,
      block_title TEXT,
      block_category TEXT,
      block_attributes TEXT,
      supports TEXT,
      code_context TEXT,
      content_hash TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS block_registrations_fts USING fts5(
      block_name,
      block_title,
      block_category,
      block_attributes,
      supports,
      code_context,
      content='block_registrations',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS api_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      api_call TEXT,
      namespace TEXT,
      method TEXT,
      code_context TEXT,
      content_hash TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS api_usages_fts USING fts5(
      api_call,
      namespace,
      method,
      code_context,
      content='api_usages',
      content_rowid='id'
    );
  `);
}

// --- Prepared statement cache ---
const stmtCache = new Map();

function stmt(db, sql) {
  if (!stmtCache.has(sql)) {
    stmtCache.set(sql, db.prepare(sql));
  }
  return stmtCache.get(sql);
}

// --- Sources ---

export function addSource(data) {
  const db = getDb();
  return stmt(db, `
    INSERT INTO sources (name, type, repo_url, subfolder, local_path, token_env_var, branch, enabled)
    VALUES (@name, @type, @repo_url, @subfolder, @local_path, @token_env_var, @branch, @enabled)
  `).run({
    name: data.name,
    type: data.type,
    repo_url: data.repo_url || null,
    subfolder: data.subfolder || null,
    local_path: data.local_path || null,
    token_env_var: data.token_env_var || null,
    branch: data.branch || 'main',
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
  });
}

export function listSources() {
  const db = getDb();
  return stmt(db, 'SELECT * FROM sources ORDER BY name').all();
}

export function getSource(name) {
  const db = getDb();
  return stmt(db, 'SELECT * FROM sources WHERE name = ?').get(name);
}

export function getSourceById(id) {
  const db = getDb();
  return stmt(db, 'SELECT * FROM sources WHERE id = ?').get(id);
}

export function removeSource(name) {
  const db = getDb();
  const source = getSource(name);
  if (!source) return null;
  stmt(db, 'DELETE FROM hooks_fts WHERE rowid IN (SELECT id FROM hooks WHERE source_id = ?)').run(source.id);
  stmt(db, 'DELETE FROM block_registrations_fts WHERE rowid IN (SELECT id FROM block_registrations WHERE source_id = ?)').run(source.id);
  stmt(db, 'DELETE FROM api_usages_fts WHERE rowid IN (SELECT id FROM api_usages WHERE source_id = ?)').run(source.id);
  stmt(db, 'DELETE FROM sources WHERE name = ?').run(name);
  return source;
}

export function isSourceIndexed(sourceId) {
  const db = getDb();
  const row = stmt(db, 'SELECT COUNT(*) as count FROM indexed_files WHERE source_id = ?').get(sourceId);
  return row.count > 0;
}

// --- Hooks ---

export function upsertHook(data) {
  const db = getDb();
  const upsertTx = db.transaction((d) => {
    const existing = stmt(db, `
      SELECT id, content_hash FROM hooks
      WHERE source_id = @source_id AND file_path = @file_path AND line_number = @line_number AND name = @name
    `).get(d);

    if (existing) {
      if (existing.content_hash === d.content_hash) {
        // No change — just bump last_seen_at
        stmt(db, 'UPDATE hooks SET last_seen_at = datetime(\'now\'), status = \'active\' WHERE id = ?').run(existing.id);
        return { id: existing.id, action: 'skipped' };
      }
      // Update
      stmt(db, `
        UPDATE hooks SET
          type = @type, php_function = @php_function, params = @params, param_count = @param_count,
          docblock = @docblock, inferred_description = @inferred_description,
          function_context = @function_context, class_name = @class_name,
          code_before = @code_before, code_after = @code_after, hook_line = @hook_line,
          is_dynamic = @is_dynamic, content_hash = @content_hash,
          status = 'active', removed_at = NULL, last_seen_at = datetime('now')
        WHERE id = @id
      `).run({ ...d, id: existing.id });
      // Update FTS — delete old, insert new
      stmt(db, 'DELETE FROM hooks_fts WHERE rowid = ?').run(existing.id);
      stmt(db, `
        INSERT INTO hooks_fts(rowid, name, type, docblock, inferred_description, function_context, class_name, params)
        VALUES (@id, @name, @type, @docblock, @inferred_description, @function_context, @class_name, @params)
      `).run({ ...d, id: existing.id });
      return { id: existing.id, action: 'updated' };
    }

    // Insert
    const result = stmt(db, `
      INSERT INTO hooks (
        source_id, file_path, line_number, name, type, php_function, params, param_count,
        docblock, inferred_description, function_context, class_name,
        code_before, code_after, hook_line, is_dynamic, content_hash, status
      ) VALUES (
        @source_id, @file_path, @line_number, @name, @type, @php_function, @params, @param_count,
        @docblock, @inferred_description, @function_context, @class_name,
        @code_before, @code_after, @hook_line, @is_dynamic, @content_hash, 'active'
      )
    `).run(d);

    stmt(db, `
      INSERT INTO hooks_fts(rowid, name, type, docblock, inferred_description, function_context, class_name, params)
      VALUES (@id, @name, @type, @docblock, @inferred_description, @function_context, @class_name, @params)
    `).run({ ...d, id: result.lastInsertRowid });

    return { id: result.lastInsertRowid, action: 'inserted' };
  });

  return upsertTx(data);
}

export function markHooksRemoved(sourceId, filePath, activeIds) {
  const db = getDb();
  const tx = db.transaction(() => {
    const allHooks = stmt(db, `
      SELECT id FROM hooks WHERE source_id = ? AND file_path = ? AND status = 'active'
    `).all(sourceId, filePath);

    const activeSet = new Set(activeIds.map(Number));
    const toRemove = allHooks.filter(h => !activeSet.has(h.id));

    const removeStmt = stmt(db, `
      UPDATE hooks SET status = 'removed', removed_at = datetime('now') WHERE id = ?
    `);

    for (const h of toRemove) {
      removeStmt.run(h.id);
    }

    return toRemove.length;
  });

  return tx();
}

export function searchHooks(query, opts = {}) {
  const db = getDb();
  const { type, source, isDynamic, includeRemoved, limit = 20 } = opts;

  // Build FTS query — escape special chars
  const ftsQuery = query.replace(/['"(){}[\]*:^~!]/g, ' ').trim();
  if (!ftsQuery) return [];

  // Tokenize and add wildcards for prefix matching
  const terms = ftsQuery.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');

  let sql = `
    SELECT h.*, s.name AS source_name,
      bm25(hooks_fts, 10, 5, 2, 3, 1, 1, 1) AS rank
    FROM hooks_fts
    JOIN hooks h ON h.id = hooks_fts.rowid
    JOIN sources s ON s.id = h.source_id
    WHERE hooks_fts MATCH @terms
  `;

  const params = { terms };

  if (!includeRemoved) {
    sql += ` AND h.status = 'active'`;
  }
  if (type) {
    sql += ` AND h.type = @type`;
    params.type = type;
  }
  if (source) {
    sql += ` AND s.name = @source`;
    params.source = source;
  }
  if (isDynamic !== undefined) {
    sql += ` AND h.is_dynamic = @isDynamic`;
    params.isDynamic = isDynamic ? 1 : 0;
  }

  sql += ` ORDER BY rank LIMIT @limit`;
  params.limit = limit;

  return db.prepare(sql).all(params);
}

export function validateHook(hookName) {
  const db = getDb();

  const exact = stmt(db, `
    SELECT h.*, s.name AS source_name FROM hooks h
    JOIN sources s ON s.id = h.source_id
    WHERE h.name = @name AND h.status = 'active'
  `).all({ name: hookName });

  if (exact.length > 0) {
    return { status: 'VALID', hooks: exact };
  }

  const removed = stmt(db, `
    SELECT h.*, s.name AS source_name FROM hooks h
    JOIN sources s ON s.id = h.source_id
    WHERE h.name = @name AND h.status = 'removed'
  `).all({ name: hookName });

  if (removed.length > 0) {
    return { status: 'REMOVED', hooks: removed };
  }

  // Try FTS for similar suggestions
  const ftsQuery = hookName.replace(/['"(){}[\]*:^~!]/g, ' ').replace(/_/g, ' ').trim();
  const terms = ftsQuery.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');

  let similar = [];
  if (terms) {
    try {
      similar = db.prepare(`
        SELECT h.name, h.type, s.name AS source_name,
          bm25(hooks_fts, 10, 5, 2, 3, 1, 1, 1) AS rank
        FROM hooks_fts
        JOIN hooks h ON h.id = hooks_fts.rowid
        JOIN sources s ON s.id = h.source_id
        WHERE hooks_fts MATCH @terms AND h.status = 'active'
        ORDER BY rank LIMIT 5
      `).all({ terms });
    } catch {
      // FTS query may fail on edge cases — return empty suggestions
    }
  }

  return { status: 'NOT_FOUND', similar };
}

export function getHookContext(idOrName) {
  const db = getDb();

  // Try by ID first
  if (typeof idOrName === 'number' || /^\d+$/.test(idOrName)) {
    const hook = stmt(db, `
      SELECT h.*, s.name AS source_name FROM hooks h
      JOIN sources s ON s.id = h.source_id
      WHERE h.id = ?
    `).get(Number(idOrName));
    if (hook) return hook;
  }

  // Try by name
  return stmt(db, `
    SELECT h.*, s.name AS source_name FROM hooks h
    JOIN sources s ON s.id = h.source_id
    WHERE h.name = ? AND h.status = 'active'
    ORDER BY h.last_seen_at DESC LIMIT 1
  `).get(idOrName);
}

// --- Block Registrations ---

export function upsertBlockRegistration(data) {
  const db = getDb();
  const tx = db.transaction((d) => {
    const existing = stmt(db, `
      SELECT id, content_hash FROM block_registrations
      WHERE source_id = @source_id AND file_path = @file_path AND line_number = @line_number AND block_name = @block_name
    `).get(d);

    if (existing) {
      if (existing.content_hash === d.content_hash) {
        stmt(db, 'UPDATE block_registrations SET last_seen_at = datetime(\'now\') WHERE id = ?').run(existing.id);
        return { id: existing.id, action: 'skipped' };
      }
      stmt(db, `
        UPDATE block_registrations SET
          block_title = @block_title, block_category = @block_category,
          block_attributes = @block_attributes, supports = @supports,
          code_context = @code_context, content_hash = @content_hash,
          last_seen_at = datetime('now')
        WHERE id = @id
      `).run({ ...d, id: existing.id });
      stmt(db, 'DELETE FROM block_registrations_fts WHERE rowid = ?').run(existing.id);
      stmt(db, `
        INSERT INTO block_registrations_fts(rowid, block_name, block_title, block_category, block_attributes, supports, code_context)
        VALUES (@id, @block_name, @block_title, @block_category, @block_attributes, @supports, @code_context)
      `).run({ ...d, id: existing.id });
      return { id: existing.id, action: 'updated' };
    }

    const result = stmt(db, `
      INSERT INTO block_registrations (source_id, file_path, line_number, block_name, block_title, block_category, block_attributes, supports, code_context, content_hash)
      VALUES (@source_id, @file_path, @line_number, @block_name, @block_title, @block_category, @block_attributes, @supports, @code_context, @content_hash)
    `).run(d);

    stmt(db, `
      INSERT INTO block_registrations_fts(rowid, block_name, block_title, block_category, block_attributes, supports, code_context)
      VALUES (@id, @block_name, @block_title, @block_category, @block_attributes, @supports, @code_context)
    `).run({ ...d, id: result.lastInsertRowid });

    return { id: result.lastInsertRowid, action: 'inserted' };
  });

  return tx(data);
}

// --- API Usages ---

export function upsertApiUsage(data) {
  const db = getDb();
  const tx = db.transaction((d) => {
    const existing = stmt(db, `
      SELECT id, content_hash FROM api_usages
      WHERE source_id = @source_id AND file_path = @file_path AND line_number = @line_number AND api_call = @api_call
    `).get(d);

    if (existing) {
      if (existing.content_hash === d.content_hash) {
        stmt(db, 'UPDATE api_usages SET last_seen_at = datetime(\'now\') WHERE id = ?').run(existing.id);
        return { id: existing.id, action: 'skipped' };
      }
      stmt(db, `
        UPDATE api_usages SET
          namespace = @namespace, method = @method,
          code_context = @code_context, content_hash = @content_hash,
          last_seen_at = datetime('now')
        WHERE id = @id
      `).run({ ...d, id: existing.id });
      stmt(db, 'DELETE FROM api_usages_fts WHERE rowid = ?').run(existing.id);
      stmt(db, `
        INSERT INTO api_usages_fts(rowid, api_call, namespace, method, code_context)
        VALUES (@id, @api_call, @namespace, @method, @code_context)
      `).run({ ...d, id: existing.id });
      return { id: existing.id, action: 'updated' };
    }

    const result = stmt(db, `
      INSERT INTO api_usages (source_id, file_path, line_number, api_call, namespace, method, code_context, content_hash)
      VALUES (@source_id, @file_path, @line_number, @api_call, @namespace, @method, @code_context, @content_hash)
    `).run(d);

    stmt(db, `
      INSERT INTO api_usages_fts(rowid, api_call, namespace, method, code_context)
      VALUES (@id, @api_call, @namespace, @method, @code_context)
    `).run({ ...d, id: result.lastInsertRowid });

    return { id: result.lastInsertRowid, action: 'inserted' };
  });

  return tx(data);
}

// --- Indexed Files ---

export function getIndexedFile(sourceId, filePath) {
  const db = getDb();
  return stmt(db, 'SELECT * FROM indexed_files WHERE source_id = ? AND file_path = ?').get(sourceId, filePath);
}

export function upsertIndexedFile(sourceId, filePath, mtimeMs, contentHash) {
  const db = getDb();
  stmt(db, `
    INSERT INTO indexed_files (source_id, file_path, mtime_ms, content_hash)
    VALUES (@source_id, @file_path, @mtime_ms, @content_hash)
    ON CONFLICT(source_id, file_path)
    DO UPDATE SET mtime_ms = @mtime_ms, content_hash = @content_hash
  `).run({ source_id: sourceId, file_path: filePath, mtime_ms: mtimeMs, content_hash: contentHash });
}

// --- FTS Rebuild ---

export function rebuildFtsIndex() {
  const db = getDb();
  const tx = db.transaction(() => {
    // Rebuild hooks FTS
    db.exec('DELETE FROM hooks_fts');
    db.exec(`
      INSERT INTO hooks_fts(rowid, name, type, docblock, inferred_description, function_context, class_name, params)
      SELECT id, name, type, docblock, inferred_description, function_context, class_name, params FROM hooks
    `);

    // Rebuild block_registrations FTS
    db.exec('DELETE FROM block_registrations_fts');
    db.exec(`
      INSERT INTO block_registrations_fts(rowid, block_name, block_title, block_category, block_attributes, supports, code_context)
      SELECT id, block_name, block_title, block_category, block_attributes, supports, code_context FROM block_registrations
    `);

    // Rebuild api_usages FTS
    db.exec('DELETE FROM api_usages_fts');
    db.exec(`
      INSERT INTO api_usages_fts(rowid, api_call, namespace, method, code_context)
      SELECT id, api_call, namespace, method, code_context FROM api_usages
    `);
  });
  tx();
}

// --- Stats ---

export function getStats() {
  const db = getDb();
  const sources = stmt(db, 'SELECT COUNT(*) as count FROM sources').get();
  const hooks = stmt(db, 'SELECT COUNT(*) as count FROM hooks WHERE status = \'active\'').get();
  const removedHooks = stmt(db, 'SELECT COUNT(*) as count FROM hooks WHERE status = \'removed\'').get();
  const blocks = stmt(db, 'SELECT COUNT(*) as count FROM block_registrations').get();
  const apis = stmt(db, 'SELECT COUNT(*) as count FROM api_usages').get();

  const perSource = db.prepare(`
    SELECT s.name,
      (SELECT COUNT(*) FROM hooks WHERE source_id = s.id AND status = 'active') AS hooks,
      (SELECT COUNT(*) FROM hooks WHERE source_id = s.id AND status = 'removed') AS removed_hooks,
      (SELECT COUNT(*) FROM block_registrations WHERE source_id = s.id) AS blocks,
      (SELECT COUNT(*) FROM api_usages WHERE source_id = s.id) AS apis,
      (SELECT COUNT(*) FROM indexed_files WHERE source_id = s.id) AS files
    FROM sources s ORDER BY s.name
  `).all();

  return {
    totals: {
      sources: sources.count,
      active_hooks: hooks.count,
      removed_hooks: removedHooks.count,
      block_registrations: blocks.count,
      api_usages: apis.count,
    },
    per_source: perSource,
  };
}

// --- Search block APIs ---

export function searchBlockApis(query, opts = {}) {
  const db = getDb();
  const { limit = 20 } = opts;
  const ftsQuery = query.replace(/['"(){}[\]*:^~!]/g, ' ').trim();
  if (!ftsQuery) return { blocks: [], apis: [] };

  const terms = ftsQuery.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');

  // Use FTS5 column filters to restrict matching to structured columns only.
  // code_context is still returned in results but won't cause false positives.
  const blockTerms = `{block_name block_title block_category} : ${terms}`;
  const apiTerms = `{api_call namespace method} : ${terms}`;

  let blocks = [];
  let apis = [];

  try {
    blocks = db.prepare(`
      SELECT br.*, s.name AS source_name,
        bm25(block_registrations_fts, 10, 5, 3, 1, 1, 0) AS rank
      FROM block_registrations_fts
      JOIN block_registrations br ON br.id = block_registrations_fts.rowid
      JOIN sources s ON s.id = br.source_id
      WHERE block_registrations_fts MATCH @terms
      ORDER BY rank LIMIT @limit
    `).all({ terms: blockTerms, limit });
  } catch {
    // FTS query may fail
  }

  try {
    apis = db.prepare(`
      SELECT au.*, s.name AS source_name,
        bm25(api_usages_fts, 10, 3, 5, 0) AS rank
      FROM api_usages_fts
      JOIN api_usages au ON au.id = api_usages_fts.rowid
      JOIN sources s ON s.id = au.source_id
      WHERE api_usages_fts MATCH @terms
      ORDER BY rank LIMIT @limit
    `).all({ terms: apiTerms, limit });
  } catch {
    // FTS query may fail
  }

  return { blocks, apis };
}
