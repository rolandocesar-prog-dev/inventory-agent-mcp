import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeInventory } from '../../test/support/setup.js';
import type { FakeInventoryApi } from '../../test/support/fake-inventory-api.js';
import type { InventoryClient } from '../inventory/client.js';
import {
  InventoryAuthError,
  InventoryProblem,
  InventoryUnavailable,
} from '../inventory/errors.js';
import { catalogTools, KARDEX_TEXT_LIMIT } from './catalog-tools.js';
import { defineTool, toErrorResult, ToolError, type Tool } from './tool.js';

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`Falta la herramienta ${name}`);
  return found;
}

describe('herramientas de consulta', () => {
  let api: FakeInventoryApi;
  let client: InventoryClient;
  let tools: Tool[];

  beforeEach(() => {
    ({ api, client } = createFakeInventory());
    tools = catalogTools(client);
  });

  it('todas son de solo lectura', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'search_products',
      'get_product',
      'low_stock_products',
      'product_movements',
    ]);
    for (const t of tools) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it('search_products devuelve líneas legibles y datos estructurados', async () => {
    const result = await tool(tools, 'search_products').run({
      query: 'martillo',
    });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain(
      'MART-001 · Martillo de carpintero 16 oz · stock 18 (mínimo 5) · precio 45.50',
    );
    // El producto desactivado no aparece.
    expect(result.text).not.toContain('VIEJO-1');
    expect(result.data).toMatchObject({ total: 1 });
  });

  it('search_products avisa cuando no hay coincidencias', async () => {
    const result = await tool(tools, 'search_products').run({
      query: 'tornillo',
    });

    expect(result.text).toBe('No hay productos que coincidan con «tornillo».');
  });

  it('get_product busca por SKU exacto sin distinguir mayúsculas', async () => {
    const result = await tool(tools, 'get_product').run({ sku: ' mart-001 ' });

    expect(result.data).toMatchObject({ sku: 'MART-001', stock: 18 });
    expect(result.text).toContain('categoría Herramientas');
  });

  it('get_product con un SKU inexistente responde error, no una lista vacía', async () => {
    const result = await tool(tools, 'get_product').run({ sku: 'MART' });

    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain(
      'No existe un producto activo con el SKU MART',
    );
  });

  it('low_stock_products ordena por faltante', async () => {
    const result = await tool(tools, 'low_stock_products').run({});

    const products = (result.data?.['products'] ?? []) as {
      sku: string;
      missing: number;
    }[];
    expect(products.map((p) => [p.sku, p.missing])).toEqual([
      ['PINT-LAT-4L', 3],
      ['CAB-25-100', 2],
      ['DEST-002', 0],
    ]);
    expect(result.text).toContain('faltan 3 para el mínimo');
  });

  it('low_stock_products sin productos bajos lo dice', async () => {
    for (const p of api.products) p.stock = p.minStock + 1;

    const result = await tool(tools, 'low_stock_products').run({});

    expect(result.text).toBe(
      'Ningún producto está en su stock mínimo o por debajo.',
    );
  });

  it('product_movements muestra el kardex con fecha, signo y usuario', async () => {
    const product = api.products[0]!;
    await client.stockIn({
      productId: product.id,
      quantity: 2,
      reason: 'Compra',
    });
    await client.stockOut({ productId: product.id, quantity: 1 });

    const result = await tool(tools, 'product_movements').run({
      sku: 'MART-001',
    });

    expect(result.text).toMatch(
      /Entrada \+2 → 20 · Compra · demo@inventario\.test/,
    );
    expect(result.text).toMatch(/Salida −1 → 19 · demo@inventario\.test/);
    expect(result.text).toContain('Stock actual: 19');
  });

  it('product_movements limita el texto a los más recientes', async () => {
    const product = api.products[0]!;
    for (let i = 0; i < KARDEX_TEXT_LIMIT + 5; i++) {
      await client.stockIn({ productId: product.id, quantity: 1 });
    }

    const result = await tool(tools, 'product_movements').run({
      sku: 'MART-001',
    });

    expect(result.text).toContain(
      `muestro los ${KARDEX_TEXT_LIMIT} más recientes de ${KARDEX_TEXT_LIMIT + 5}`,
    );
    expect(result.data?.['movements']).toHaveLength(KARDEX_TEXT_LIMIT + 5);
  });

  it('product_movements sin movimientos en el rango lo dice', async () => {
    const result = await tool(tools, 'product_movements').run({
      sku: 'MART-001',
      from: '2020-01-01',
      to: '2020-01-31',
    });

    expect(result.text).toBe('MART-001 no tiene movimientos en ese período.');
  });

  it('valida la entrada antes de llamar a la API', async () => {
    const calls = api.calls.length;

    const result = await tool(tools, 'product_movements').run({
      sku: 'MART-001',
      from: '10/11/2026',
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('from: Usa el formato AAAA-MM-DD');
    expect(api.calls).toHaveLength(calls);
  });
});

describe('toErrorResult', () => {
  it.each([
    [new ToolError('SKU inexistente'), 'SKU inexistente'],
    [new InventoryUnavailable(), 'no está disponible'],
    [
      new InventoryProblem(
        422,
        'No se puede procesar',
        'Stock insuficiente: hay 1',
      ),
      'La API de inventario rechazó la operación: Stock insuficiente: hay 1',
    ],
    [new InventoryAuthError('x'), 'No hay sesión válida'],
  ])('%s', (error, text) => {
    const result = toErrorResult(error);

    expect(result.isError).toBe(true);
    expect(result.text).toContain(text);
  });

  it('un error inesperado no muestra detalles internos y se registra en stderr', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = toErrorResult(new Error('password=secreta'));

    expect(result.text).toBe('Ocurrió un error inesperado en la herramienta.');
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('defineTool convierte en resultado de error lo que lanza el handler', async () => {
    const failing = defineTool({
      name: 'falla',
      title: 'Falla',
      description: 'Siempre falla',
      inputSchema: {},
      annotations: {},
      handler: () => Promise.reject(new ToolError('no se pudo')),
    });

    await expect(failing.run(undefined)).resolves.toEqual({
      isError: true,
      text: 'no se pudo',
    });
  });
});
