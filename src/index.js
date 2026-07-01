#!/usr/bin/env node
// src/index.js
//
// stdio MCP server exposing Google Tag Manager as resource-grouped tools.
// Point any MCP client (Claude Desktop, opencode, Cursor, ...) at this process.
//
// Auth + guardrails are configured entirely through environment variables — see
// README.md and .env.sample.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { buildTools, callTool } from './gtm.js';
import { makeGetAccessToken } from './auth.js';

// Guardrails default to READ-ONLY. Opt into mutations explicitly. Even when
// enabled, delete/publish/high-impact ops still require confirm:true per call.
const gtm = {
  enableWrites: process.env.GTM_MCP_ENABLE_WRITES === 'true',
  enableDeletes: process.env.GTM_MCP_ENABLE_DELETES === 'true',
  enablePublish: process.env.GTM_MCP_ENABLE_PUBLISH === 'true',
  defaultEmail: process.env.MCP_GTM_EMAIL || '',
};

const getAccessToken = makeGetAccessToken();

async function main() {
  const server = new Server({ name: 'gtm-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await buildTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(getAccessToken, request.params.name, request.params.arguments || {}, gtm)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; nothing else to do.
}

main().catch((err) => {
  process.stderr.write(`gtm-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
