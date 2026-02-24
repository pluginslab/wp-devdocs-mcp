#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { searchHooksSchema, handleSearchHooks } from './server/tools/search-hooks.js';
import { validateHookSchema, handleValidateHook } from './server/tools/validate-hook.js';
import { getHookContextSchema, handleGetHookContext } from './server/tools/get-hook-context.js';
import { searchBlockApisSchema, handleSearchBlockApis } from './server/tools/search-block-apis.js';

// Initialize DB on import (side effect)
import { getDb } from './db/sqlite.js';

const server = new McpServer({
  name: 'wp-devdocs-mcp',
  version: '1.0.1',
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
