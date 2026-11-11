import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { InventoryClient } from '../inventory/client.js';
import { catalogTools } from '../tools/catalog-tools.js';
import { ConfirmationStore } from '../tools/confirmations.js';
import { movementTools } from '../tools/movement-tools.js';
import type { Tool, ToolResult } from '../tools/tool.js';
import { VERSION } from '../version.js';

export const SERVER_NAME = 'inventory-mcp';

/** Guía para el modelo de cualquier cliente MCP (se envía al iniciar la sesión). */
export const SERVER_INSTRUCTIONS = [
  'Herramientas del inventario de un pequeño comercio, con permisos de operador.',
  'Para registrar una entrada o salida: llama a prepare_stock_movement, muestra el resumen al usuario y solo si lo aprueba llama a confirm_stock_movement con el código.',
  'No inventes cifras: consulta con las herramientas. Si algo no se puede hacer con ellas (crear o borrar productos, ajustes, usuarios), dilo.',
].join('\n');

export function createTools(
  client: InventoryClient,
  confirmations = new ConfirmationStore(),
): Tool[] {
  return [...catalogTools(client), ...movementTools(client, confirmations)];
}

export function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: result.text }],
    ...(result.data ? { structuredContent: result.data } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

/** Servidor MCP con las herramientas registradas y sus anotaciones (RF-02, RF-03). */
export function createInventoryServer(tools: Tool[]): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args) => toCallToolResult(await tool.run(args)),
    );
  }
  return server;
}
