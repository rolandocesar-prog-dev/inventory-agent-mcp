import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeInventory } from '../../test/support/setup.js';
import { createInventoryServer, createTools } from '../server/create-server.js';
import { McpConnection, serverTransport } from './mcp-connection.js';
import { ModelError, OllamaChat, toOllamaTools } from './ollama.js';

describe('McpConnection', () => {
  let connection: McpConnection;

  beforeEach(async () => {
    const server = createInventoryServer(
      createTools(createFakeInventory().client),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    connection = await McpConnection.connect(clientSide);
  });

  afterEach(async () => {
    await connection.close();
  });

  it('lista las herramientas con su esquema y marca las destructivas', async () => {
    const tools = await connection.listTools();

    expect(tools.filter((t) => t.destructive).map((t) => t.name)).toEqual([
      'confirm_stock_movement',
    ]);
    const prepare = tools.find((t) => t.name === 'prepare_stock_movement');
    expect(prepare?.parameters).toMatchObject({
      type: 'object',
      properties: { quantity: { type: 'integer' } },
    });
    expect(prepare?.parameters).not.toHaveProperty('$schema');
  });

  it('llama herramientas y devuelve texto, datos y error', async () => {
    const ok = await connection.callTool('get_product', { sku: 'MART-001' });
    const failed = await connection.callTool('get_product', { sku: 'NADA' });

    expect(ok).toMatchObject({ isError: false, data: { stock: 18 } });
    expect(ok.text).toContain('MART-001');
    expect(failed.isError).toBe(true);
    expect(failed).not.toHaveProperty('data');
  });

  it('convierte las herramientas al formato de Ollama', async () => {
    const [first] = toOllamaTools(await connection.listTools());

    expect(first).toMatchObject({
      type: 'function',
      function: { name: 'search_products', parameters: { type: 'object' } },
    });
  });
});

describe('serverTransport', () => {
  it('pasa al servidor solo las variables que necesita', () => {
    const transport = serverTransport(
      {
        INVENTORY_API_URL: 'http://localhost:3000/api/v1',
        INVENTORY_EMAIL: 'demo@inventario.test',
        INVENTORY_PASSWORD: 'secreta',
        AWS_SECRET_ACCESS_KEY: 'no-debe-pasar',
      },
      'D:/ruta con espacios/main.js',
    );
    const params = (
      transport as unknown as {
        _serverParams: { args: string[]; env: Record<string, string> };
      }
    )._serverParams;

    expect(params.args).toEqual(['D:/ruta con espacios/main.js']);
    expect(params.env).toEqual({
      INVENTORY_API_URL: 'http://localhost:3000/api/v1',
      INVENTORY_EMAIL: 'demo@inventario.test',
      INVENTORY_PASSWORD: 'secreta',
    });
  });
});

describe('OllamaChat', () => {
  const tools = [
    {
      name: 'get_product',
      description: 'Ver un producto',
      parameters: { type: 'object' },
      destructive: false,
    },
  ];

  it('envía modelo, mensajes y herramientas, sin streaming ni pensamiento', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        message: {
          content: '',
          tool_calls: [
            {
              function: { name: 'get_product', arguments: { sku: 'MART-001' } },
            },
          ],
        },
      }),
    );
    const chat = new OllamaChat('http://ollama:11434', 'qwen3.5:9b', fetchFn);

    const reply = await chat.chat([{ role: 'user', content: 'hola' }], tools);

    expect(reply.toolCalls[0]?.function.name).toBe('get_product');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://ollama:11434/api/chat');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'qwen3.5:9b',
      stream: false,
      think: false,
      tools: [{ type: 'function', function: { name: 'get_product' } }],
    });
  });

  it.each([
    [
      'Ollama cerrado',
      () => Promise.reject(new TypeError('fetch failed')),
      /No se pudo conectar con Ollama/,
    ],
    [
      'modelo sin descargar',
      () => Promise.resolve(new Response('model not found', { status: 404 })),
      /ollama pull qwen3.5:9b/,
    ],
    [
      'otro error',
      () => Promise.resolve(new Response('boom', { status: 500 })),
      /Ollama respondió 500: boom/,
    ],
  ])('%s', async (_caso, fetchFn, message) => {
    const chat = new OllamaChat('http://ollama:11434', 'qwen3.5:9b', fetchFn);

    const error = await chat.chat([], tools).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(String(error)).toMatch(message);
  });

  it('una respuesta sin mensaje se toma como vacía', async () => {
    const chat = new OllamaChat('http://o', 'm', () =>
      Promise.resolve(Response.json({})),
    );

    await expect(chat.chat([], tools)).resolves.toEqual({
      content: '',
      toolCalls: [],
    });
  });
});
