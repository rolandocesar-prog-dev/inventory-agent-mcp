import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInventoryServer,
  createTools,
  SERVER_NAME,
} from '../src/server/create-server.js';
import { StartupError, verifyAccount } from '../src/server/start.js';
import { VERSION } from '../src/version.js';
import type { FakeInventoryApi } from './support/fake-inventory-api.js';
import { createFakeInventory } from './support/setup.js';

/** Servidor MCP real hablando con un cliente MCP real, en memoria (design §7). */
describe('servidor MCP (integración)', () => {
  let api: FakeInventoryApi;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const textOf = (result: CallToolResult) =>
    result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

  beforeEach(async () => {
    const fake = createFakeInventory();
    api = fake.api;
    const server = createInventoryServer(createTools(fake.client));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'prueba', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it('se presenta con nombre, versión e instrucciones', () => {
    expect(client.getServerVersion()).toEqual({
      name: SERVER_NAME,
      version: VERSION,
    });
    expect(client.getInstructions()).toContain('prepare_stock_movement');
  });

  it('expone las 6 herramientas con sus anotaciones y esquemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      'search_products',
      'get_product',
      'low_stock_products',
      'product_movements',
      'prepare_stock_movement',
      'confirm_stock_movement',
    ]);
    const confirm = tools.find((t) => t.name === 'confirm_stock_movement');
    expect(confirm?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    const prepare = tools.find((t) => t.name === 'prepare_stock_movement');
    expect(prepare?.inputSchema).toMatchObject({
      type: 'object',
      required: ['type', 'sku', 'quantity'],
      properties: { type: { enum: ['in', 'out'] } },
    });
  });

  it('una consulta devuelve texto y datos estructurados', async () => {
    const result = await call('get_product', { sku: 'MART-001' });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('MART-001 · Martillo de carpintero 16 oz');
    expect(result.structuredContent).toMatchObject({
      sku: 'MART-001',
      stock: 18,
    });
  });

  it('preparar y confirmar por MCP registra la salida una sola vez', async () => {
    const prepared = await call('prepare_stock_movement', {
      type: 'out',
      sku: 'MART-001',
      quantity: 2,
      reason: 'Venta',
    });
    const code = (prepared.structuredContent as { code: string }).code;

    const confirmed = await call('confirm_stock_movement', { code });
    const repeated = await call('confirm_stock_movement', { code });

    expect(textOf(confirmed)).toContain('Stock actual de MART-001: 16');
    expect(repeated.isError).toBe(true);
    expect(api.products.find((p) => p.sku === 'MART-001')?.stock).toBe(16);
  });

  it('los errores de la API llegan como isError con el detalle', async () => {
    const result = await call('prepare_stock_movement', {
      type: 'out',
      sku: 'CAB-25-100',
      quantity: 9,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No alcanza: hay 1 de CAB-25-100');
  });

  it('una entrada que no cumple el esquema se rechaza sin tocar la API', async () => {
    const calls = api.calls.length;

    const result = await call('prepare_stock_movement', {
      type: 'out',
      sku: 'MART-001',
      quantity: -4,
    });

    expect(result.isError).toBe(true);
    expect(api.calls).toHaveLength(calls);
  });
});

describe('arranque del servidor', () => {
  it('acepta una cuenta de operador', async () => {
    await expect(
      verifyAccount(createFakeInventory().client),
    ).resolves.toBeUndefined();
  });

  it('rechaza una cuenta de admin (mínimo privilegio)', async () => {
    const admin = {
      me: () =>
        Promise.resolve({
          id: 'u',
          email: 'admin@inventario.test',
          role: 'ADMIN' as const,
          active: true,
        }),
    };

    await expect(verifyAccount(admin)).rejects.toThrow(StartupError);
    await expect(verifyAccount(admin)).rejects.toThrow(/rol ADMIN/);
  });

  it('la versión coincide con package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      version: string;
    };

    expect(VERSION).toBe(pkg.version);
  });
});
