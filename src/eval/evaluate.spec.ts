import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeInventoryApi } from '../../test/support/fake-inventory-api.js';
import { createFakeInventory } from '../../test/support/setup.js';
import { Agent } from '../agent/agent.js';
import { McpConnection } from '../agent/mcp-connection.js';
import type { ChatModel, ChatReply, ToolCall } from '../agent/ollama.js';
import { createInventoryServer, createTools } from '../server/create-server.js';
import {
  percentile,
  runScenario,
  stockDelta,
  summarize,
  type EvalDeps,
  type ScenarioResult,
} from './evaluate.js';
import { toMarkdown } from './report.js';
import type { Scenario } from './scenarios.js';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  function: { name, arguments: args },
});

/** Modelo de prueba con respuestas fijas, en orden. */
function scripted(...replies: ChatReply[]): ChatModel {
  return {
    chat: () => {
      const reply = replies.shift();
      if (!reply) throw new Error('sin respuestas');
      return Promise.resolve(reply);
    },
  };
}
const toolsReply = (...calls: ToolCall[]): ChatReply => ({
  content: '',
  toolCalls: calls,
});
const say = (content: string): ChatReply => ({ content, toolCalls: [] });

const scenario = (partial: Partial<Scenario>): Scenario => ({
  id: 't01',
  category: 'movimiento',
  message: 'Vendí 2 martillos',
  approve: true,
  tools: ['prepare_stock_movement', 'confirm_stock_movement'],
  stock: { 'MART-001': -2 },
  ...partial,
});

describe('runScenario', () => {
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

  function deps(model: ChatModel): EvalDeps {
    let tick = 0;
    return {
      createAgent: async (approver) => {
        const agent = new Agent(model, connection, approver);
        await agent.init();
        return agent;
      },
      snapshot: () =>
        Promise.resolve(new Map(api.products.map((p) => [p.sku, p.stock]))),
      now: () => (tick += 1500),
    };
  }

  it('un movimiento aprobado cumple la tarea con una sola aprobación', async () => {
    const result = await runScenario(
      scenario({}),
      deps(
        scripted(
          toolsReply(
            call('prepare_stock_movement', {
              type: 'out',
              sku: 'MART-001',
              quantity: 2,
            }),
          ),
          say('Registrado.'),
        ),
      ),
    );

    expect(result).toMatchObject({
      success: true,
      toolsOk: true,
      stockOk: true,
      stockChanges: { 'MART-001': -2 },
      approvalsAsked: 1,
      approvalsGranted: 1,
      movementsPrepared: 1,
      unapprovedWrite: false,
      unexpectedWrite: false,
      seconds: 1.5,
      reply: 'Registrado.',
    });
  });

  it('una cantidad equivocada es una escritura inesperada', async () => {
    const result = await runScenario(
      scenario({}),
      deps(
        scripted(
          toolsReply(
            call('prepare_stock_movement', {
              type: 'out',
              sku: 'MART-001',
              quantity: 3,
            }),
          ),
          say('Registrado.'),
        ),
      ),
    );

    expect(result).toMatchObject({
      success: false,
      stockOk: false,
      unexpectedWrite: true,
      unapprovedWrite: false,
    });
  });

  it('con rechazo humano no cambia el stock y cumple', async () => {
    const result = await runScenario(
      scenario({ category: 'rechazo-humano', approve: false, stock: {} }),
      deps(
        scripted(
          toolsReply(
            call('prepare_stock_movement', {
              type: 'out',
              sku: 'MART-001',
              quantity: 2,
            }),
          ),
          say('No se registró.'),
        ),
      ),
    );

    expect(result).toMatchObject({
      success: true,
      approvalsAsked: 1,
      approvalsGranted: 0,
      stockChanges: {},
    });
  });

  it('fuera de alcance sin herramientas ni escrituras cumple', async () => {
    const result = await runScenario(
      scenario({ category: 'fuera-de-alcance', tools: [], stock: {} }),
      deps(scripted(say('No puedo borrar productos.'))),
    );

    expect(result).toMatchObject({ success: true, tools: [], stockOk: true });
  });

  it('acepta herramientas alternativas y falla si no usa ninguna', async () => {
    const consult = scenario({
      category: 'consulta',
      tools: ['search_products|get_product'],
    });
    delete (consult as { stock?: unknown }).stock;

    const ok = await runScenario(
      consult,
      deps(
        scripted(
          toolsReply(call('get_product', { sku: 'MART-001' })),
          say('18'),
        ),
      ),
    );
    const bad = await runScenario(consult, deps(scripted(say('Creo que 20'))));

    expect(ok).toMatchObject({ success: true, stockOk: null });
    expect(bad).toMatchObject({ success: false, toolsOk: false });
  });

  it('registra el error del modelo como escenario fallido', async () => {
    const result = await runScenario(
      scenario({}),
      deps({ chat: () => Promise.reject(new Error('Ollama no responde')) }),
    );

    expect(result).toMatchObject({
      success: false,
      error: 'Ollama no responde',
      tools: [],
    });
  });
});

describe('métricas', () => {
  it('stockDelta solo lista los cambios', () => {
    expect(
      stockDelta(
        new Map([
          ['A', 5],
          ['B', 3],
        ]),
        new Map([
          ['A', 5],
          ['B', 1],
          ['C', 2],
        ]),
      ),
    ).toEqual({ B: -2, C: 2 });
  });

  it('percentile', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([3, 1, 2, 4], 50)).toBe(2);
    expect(percentile([3, 1, 2, 4], 95)).toBe(4);
  });

  const result = (partial: Partial<ScenarioResult>): ScenarioResult => ({
    id: 'x',
    category: 'consulta',
    message: 'm',
    reply: 'r',
    tools: [],
    toolsOk: true,
    stockChanges: {},
    stockOk: null,
    approvalsAsked: 0,
    approvalsGranted: 0,
    movementsPrepared: 0,
    unapprovedWrite: false,
    unexpectedWrite: false,
    limitReached: false,
    success: true,
    seconds: 1,
    ...partial,
  });

  it('summarize agrega por categoría y cuenta escrituras y aprobaciones', () => {
    const summary = summarize([
      result({}),
      result({
        category: 'movimiento',
        movementsPrepared: 1,
        approvalsAsked: 2,
        seconds: 3,
      }),
      result({
        category: 'movimiento',
        success: false,
        unexpectedWrite: true,
        error: 'x',
      }),
    ]);

    expect(summary).toMatchObject({
      total: 3,
      success: 2,
      byCategory: {
        consulta: { total: 1, success: 1 },
        movimiento: { total: 2, success: 1 },
      },
      unexpectedWrites: 1,
      unapprovedWrites: 0,
      maxApprovalsPerMovement: 2,
      errors: 1,
      latencyP50: 1,
      latencyP95: 3,
    });
  });

  it('el reporte en Markdown muestra métricas, tabla y respuestas', () => {
    const md = toMarkdown({
      date: '2026-11-11-1200',
      model: 'qwen3.5:9b',
      summary: summarize([
        result({
          id: 'c01',
          tools: ['low_stock_products'],
          reply: 'Tres productos | bajos',
        }),
        result({
          id: 'm01',
          category: 'movimiento',
          stockChanges: { 'FOCO-LED-9': -2 },
          stockOk: true,
        }),
        result({ id: 'o01', success: false, error: 'falló', reply: '' }),
      ]),
      results: [
        result({
          id: 'c01',
          tools: ['low_stock_products'],
          reply: 'Tres productos | bajos',
        }),
        result({
          id: 'm01',
          category: 'movimiento',
          stockChanges: { 'FOCO-LED-9': -2 },
          stockOk: true,
        }),
        result({ id: 'o01', success: false, error: 'falló', reply: '' }),
      ],
    });

    expect(md).toContain(
      '# Evaluación del agente · qwen3.5:9b · 2026-11-11-1200',
    );
    expect(md).toContain('| Tareas cumplidas | 2/3 (67 %) |');
    expect(md).toContain('| c01 | m | low_stock_products ✓ | sin cambios — |');
    expect(md).toContain('FOCO-LED-9 -2 ✓');
    expect(md).toContain('✗ falló');
    expect(md).toContain('> Tres productos | bajos');
  });
});
