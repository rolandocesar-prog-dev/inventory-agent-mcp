import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeInventoryApi } from '../../test/support/fake-inventory-api.js';
import { createFakeInventory } from '../../test/support/setup.js';
import { createInventoryServer, createTools } from '../server/create-server.js';
import {
  Agent,
  LIMIT_REACHED,
  MAX_TOOL_CALLS,
  NOT_APPROVED,
  type ApprovalRequest,
  type Approver,
} from './agent.js';
import { McpConnection } from './mcp-connection.js';
import type { ChatMessage, ChatModel, ChatReply, ToolCall } from './ollama.js';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  function: { name, arguments: args },
});

/**
 * Modelo de prueba: cada paso recibe el historial y decide la respuesta, así
 * puede leer el código que devolvió prepare_stock_movement.
 */
class ScriptedModel implements ChatModel {
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly steps: ((h: ChatMessage[]) => ChatReply)[]) {}

  chat(messages: ChatMessage[]): Promise<ChatReply> {
    this.seen.push([...messages]);
    const step = this.steps.shift();
    if (!step) throw new Error('El modelo de prueba se quedó sin pasos');
    return Promise.resolve(step(messages));
  }
}

class StubApprover implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answer: boolean) {}
  approve(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return Promise.resolve(this.answer);
  }
}

const say = (content: string) => (): ChatReply => ({ content, toolCalls: [] });
const tools =
  (...calls: ToolCall[]) =>
  (): ChatReply => ({ content: '', toolCalls: calls });
const lastTool = (history: ChatMessage[]) =>
  [...history].reverse().find((m) => m.role === 'tool')?.content ?? '';
const codeIn = (text: string) => /código ([A-Z2-9]{6})/.exec(text)?.[1] ?? '';

describe('Agent', () => {
  let api: FakeInventoryApi;
  let connection: McpConnection;

  beforeEach(async () => {
    const fake = createFakeInventory();
    api = fake.api;
    const server = createInventoryServer(createTools(fake.client));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    connection = await McpConnection.connect(clientSide);
  });

  afterEach(async () => {
    await connection.close();
  });

  const stockOf = (sku: string) =>
    api.products.find((p) => p.sku === sku)?.stock;

  async function agentWith(
    steps: ((h: ChatMessage[]) => ChatReply)[],
    approve = true,
  ) {
    const model = new ScriptedModel(steps);
    const approver = new StubApprover(approve);
    const agent = new Agent(model, connection, approver);
    await agent.init();
    return { agent, model, approver };
  }

  it('responde una consulta usando la herramienta y su resultado', async () => {
    const { agent, model } = await agentWith([
      tools(call('get_product', { sku: 'MART-001' })),
      (h) => say(`Te quedan 18. (${lastTool(h).slice(0, 8)})`)(),
    ]);

    const reply = await agent.send('¿Cuántos martillos quedan?');

    expect(reply.text).toBe('Te quedan 18. (MART-001)');
    expect(reply.trace).toEqual([
      { tool: 'get_product', args: { sku: 'MART-001' }, isError: false },
    ]);
    // El segundo turno del modelo ya ve el resultado de la herramienta.
    expect(model.seen[1]?.at(-1)).toMatchObject({
      role: 'tool',
      tool_name: 'get_product',
    });
  });

  it('pide aprobación con el resumen y registra si la persona acepta', async () => {
    const { agent, approver } = await agentWith([
      tools(
        call('prepare_stock_movement', {
          type: 'out',
          sku: 'MART-001',
          quantity: 3,
        }),
      ),
      (h) =>
        tools(call('confirm_stock_movement', { code: codeIn(lastTool(h)) }))(),
      say('Listo, registré la venta.'),
    ]);

    const reply = await agent.send('Vendí 3 martillos');

    expect(stockOf('MART-001')).toBe(15);
    expect(approver.requests).toHaveLength(1);
    expect(approver.requests[0]?.summary).toContain(
      'Salida de 3 × MART-001 · Martillo de carpintero 16 oz',
    );
    expect(approver.requests[0]?.summary).toContain('Stock: 18 → 15.');
    expect(reply.trace.at(-1)).toMatchObject({
      tool: 'confirm_stock_movement',
      approved: true,
      isError: false,
    });
  });

  it('si la persona no aprueba, no llama a la herramienta ni cambia el stock', async () => {
    const { agent, model } = await agentWith(
      [
        tools(
          call('prepare_stock_movement', {
            type: 'out',
            sku: 'MART-001',
            quantity: 3,
          }),
        ),
        (h) =>
          tools(
            call('confirm_stock_movement', { code: codeIn(lastTool(h)) }),
          )(),
        say('Entendido, no registré nada.'),
      ],
      false,
    );
    const before = api.calls.length;

    const reply = await agent.send('Vendí 3 martillos');

    expect(stockOf('MART-001')).toBe(18);
    expect(
      api.calls.slice(before).some((c) => c.startsWith('POST /stock')),
    ).toBe(false);
    expect(reply.trace.at(-1)).toMatchObject({ approved: false });
    expect(lastTool(model.seen[2] ?? [])).toBe(NOT_APPROVED);
  });

  it('pide aprobación aunque el modelo invente un código (sin resumen)', async () => {
    const { agent, approver } = await agentWith([
      tools(call('confirm_stock_movement', { code: 'ZZZZZZ' })),
      say('No pude registrar.'),
    ]);

    const reply = await agent.send('Confirma lo de antes');

    expect(approver.requests[0]).toEqual({
      tool: 'confirm_stock_movement',
      args: { code: 'ZZZZZZ' },
    });
    expect(reply.trace[0]).toMatchObject({ approved: true, isError: true });
  });

  it('una herramienta inexistente vuelve como error al modelo', async () => {
    const { agent, model } = await agentWith([
      tools(call('delete_product', { sku: 'MART-001' })),
      say('No puedo borrar productos.'),
    ]);

    const reply = await agent.send('Borra el martillo');

    expect(reply.trace).toEqual([
      { tool: 'delete_product', args: { sku: 'MART-001' }, isError: true },
    ]);
    expect(lastTool(model.seen[1] ?? [])).toContain('no existe');
  });

  it(`corta en ${MAX_TOOL_CALLS} llamadas por mensaje y lo avisa`, async () => {
    const loop = tools(
      call('search_products', { query: 'x' }),
      call('search_products', { query: 'y' }),
    );
    const { agent, model } = await agentWith([loop, loop, loop, loop]);

    const reply = await agent.send('Busca todo');

    expect(reply).toMatchObject({ text: LIMIT_REACHED, limitReached: true });
    expect(reply.trace).toHaveLength(MAX_TOOL_CALLS);
    expect(model.seen).toHaveLength(3);
  });

  it('cada llamada pedida recibe su resultado aunque se pase del límite', async () => {
    const many = tools(
      ...Array.from({ length: MAX_TOOL_CALLS + 2 }, () =>
        call('low_stock_products'),
      ),
    );
    const { agent } = await agentWith([many]);

    const reply = await agent.send('Revisa el stock bajo muchas veces');

    expect(reply.trace).toHaveLength(MAX_TOOL_CALLS);
    expect(reply.limitReached).toBe(true);
  });

  it('conserva la conversación entre mensajes', async () => {
    const { agent, model } = await agentWith([say('Hola'), say('Sigo aquí')]);

    await agent.send('Hola');
    await agent.send('¿Sigues?');

    expect(model.seen[1]?.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });
});
