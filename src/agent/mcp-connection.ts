import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.js';

/** Herramienta tal como la ve el agente (de `tools/list`). */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema de la entrada. */
  parameters: Record<string, unknown>;
  /** `destructiveHint`: requiere aprobación humana antes de llamarla (RF-05). */
  destructive: boolean;
}

export interface ToolCallOutcome {
  text: string;
  data?: Record<string, unknown>;
  isError: boolean;
}

/** Lo que el agente necesita de un servidor de herramientas. */
export interface ToolCaller {
  listTools(): Promise<AgentTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome>;
  close(): Promise<void>;
}

/** Cliente MCP: el agente nunca habla con la API directamente (design §5). */
export class McpConnection implements ToolCaller {
  private constructor(private readonly client: Client) {}

  static async connect(transport: Transport): Promise<McpConnection> {
    const client = new Client({ name: 'inventory-agent', version: VERSION });
    await client.connect(transport);
    return new McpConnection(client);
  }

  async listTools(): Promise<AgentTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => {
      const { $schema: _ignored, ...parameters } = tool.inputSchema as Record<
        string,
        unknown
      >;
      return {
        name: tool.name,
        description: tool.description ?? tool.title ?? tool.name,
        parameters,
        destructive: tool.annotations?.destructiveHint === true,
      };
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
    const text = result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    return {
      text,
      isError: result.isError === true,
      ...(result.structuredContent ? { data: result.structuredContent } : {}),
    };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** Variables que el servidor necesita; el resto del entorno no se le pasa. */
const SERVER_ENV = [
  'INVENTORY_API_URL',
  'INVENTORY_EMAIL',
  'INVENTORY_PASSWORD',
  'PATH',
  'SystemRoot',
] as const;

/** Lanza `dist/server/main.js` como proceso hijo y habla MCP por stdio. */
export function serverTransport(
  env: NodeJS.ProcessEnv = process.env,
  serverPath = fileURLToPath(new URL('../server/main.js', import.meta.url)),
): StdioClientTransport {
  const childEnv: Record<string, string> = {};
  for (const key of SERVER_ENV) {
    const value = env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  return new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: childEnv,
    stderr: 'inherit',
  });
}
