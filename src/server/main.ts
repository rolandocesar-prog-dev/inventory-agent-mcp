#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadInventoryConfig } from '../config.js';
import { InventoryClient } from '../inventory/client.js';
import { createInventoryServer, createTools } from './create-server.js';
import { verifyAccount } from './start.js';

// Por stdio, stdout es solo del protocolo MCP: todo lo demás va a stderr (RNF-02).
try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables del entorno (p. ej. las del cliente MCP).
}

try {
  const client = new InventoryClient(loadInventoryConfig());
  await verifyAccount(client);
  const server = createInventoryServer(createTools(client));
  await server.connect(new StdioServerTransport());
  console.error('[inventory-mcp] listo: conectado a la API como operador.');
} catch (error) {
  console.error(
    `[inventory-mcp] no se pudo iniciar: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
