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
import { getDb } from './db/sqlite.js';

const server = new McpServer({
  name: 'wp-devdocs-mcp',
  version: '2.0.0',
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
