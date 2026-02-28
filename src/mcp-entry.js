#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { searchHooksSchema, handleSearchHooks } from './server/tools/search-hooks.js';
import { validateHookSchema, handleValidateHook } from './server/tools/validate-hook.js';
import { getHookContextSchema, handleGetHookContext } from './server/tools/get-hook-context.js';
import { searchBlockApisSchema, handleSearchBlockApis } from './server/tools/search-block-apis.js';
import { searchDocsSchema, handleSearchDocs } from './server/tools/search-docs.js';
import { getDocSchema, handleGetDoc } from './server/tools/get-doc.js';
import { listDocsSchema, handleListDocs } from './server/tools/list-docs.js';

// Initialize DB on import (side effect)
import { getDb, getStaleSources } from './db/sqlite.js';
import { indexSources } from './indexer/index-manager.js';

const server = new McpServer({
  name: 'wp-devdocs-mcp',
  version: '1.1.0',
});

// Register tools
server.tool(
  searchHooksSchema.name,
  searchHooksSchema.description,
  searchHooksSchema.inputSchema,
  handleSearchHooks,
);

server.tool(
  validateHookSchema.name,
  validateHookSchema.description,
  validateHookSchema.inputSchema,
  handleValidateHook,
);

server.tool(
  getHookContextSchema.name,
  getHookContextSchema.description,
  getHookContextSchema.inputSchema,
  handleGetHookContext,
);

server.tool(
  searchBlockApisSchema.name,
  searchBlockApisSchema.description,
  searchBlockApisSchema.inputSchema,
  handleSearchBlockApis,
);

server.tool(
  searchDocsSchema.name,
  searchDocsSchema.description,
  searchDocsSchema.inputSchema,
  handleSearchDocs,
);

server.tool(
  getDocSchema.name,
  getDocSchema.description,
  getDocSchema.inputSchema,
  handleGetDoc,
);

server.tool(
  listDocsSchema.name,
  listDocsSchema.description,
  listDocsSchema.inputSchema,
  handleListDocs,
);

// Ensure DB is ready
try {
  getDb();
} catch (err) {
  process.stderr.write(`Failed to initialize database: ${err.message}\n`);
  process.exit(1);
}

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

// Background auto-update of stale sources (fire-and-forget)
async function autoUpdate() {
  if (process.env.WP_MCP_AUTO_UPDATE === 'false') return;
  try {
    const staleSources = getStaleSources(24 * 60 * 60 * 1000);
    if (staleSources.length === 0) return;

    process.stderr.write(`Auto-updating ${staleSources.length} stale source(s)...\n`);

    for (const source of staleSources) {
      try {
        await indexSources({ sourceName: source.name });
        process.stderr.write(`  Updated: ${source.name}\n`);
      } catch (err) {
        process.stderr.write(`  Error updating ${source.name}: ${err.message}\n`);
      }
    }

    process.stderr.write(`Auto-update complete.\n`);
  } catch (err) {
    process.stderr.write(`Auto-update failed: ${err.message}\n`);
  }
}

autoUpdate();
