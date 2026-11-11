import { beforeEach, describe, expect, it } from 'vitest';
import { FakeInventoryApi } from '../../test/support/fake-inventory-api.js';
import { InventoryClient } from './client.js';
import { InventoryProblem } from './errors.js';

describe('InventoryClient (operaciones)', () => {
  let api: FakeInventoryApi;
  let client: InventoryClient;

  beforeEach(() => {
    api = new FakeInventoryApi();
    client = new InventoryClient(
      {
        apiUrl: api.baseUrl,
        email: 'demo@inventario.test',
        password: 'demo-inventario-2026',
      },
      api.fetch,
    );
  });

  it('busca por nombre o SKU con paginación', async () => {
    api.addProduct({ sku: 'MART-001', name: 'Martillo' });
    api.addProduct({ sku: 'ROD-009', name: 'Rodillo' });

    const page = await client.searchProducts('mart');

    expect(page.data.map((p) => p.sku)).toEqual(['MART-001']);
    expect(page.meta).toMatchObject({ page: 1, pageSize: 20, total: 1 });
  });

  it('sin búsqueda no envía el parámetro vacío', async () => {
    const urls: string[] = [];
    const spying = new InventoryClient(
      {
        apiUrl: api.baseUrl,
        email: 'demo@inventario.test',
        password: 'demo-inventario-2026',
      },
      (input, init) => {
        urls.push(input instanceof Request ? input.url : input.toString());
        return api.fetch(input, init);
      },
    );

    await spying.searchProducts('');

    expect(urls.at(-1)).toBe(`${api.baseUrl}/products?page=1&pageSize=20`);
  });

  it('recorre todas las páginas del catálogo', async () => {
    for (let i = 0; i < 230; i++) {
      api.addProduct({ sku: `P-${i}`, name: `Producto ${i}` });
    }

    const all = await client.listAllProducts();

    expect(all).toHaveLength(230);
    expect(api.calls.filter((c) => c === 'GET /products')).toHaveLength(3);
  });

  it('registra entradas y salidas y lee el kardex', async () => {
    const product = api.addProduct({ sku: 'MART-001', name: 'Martillo' });

    const entry = await client.stockIn({
      productId: product.id,
      quantity: 10,
      reason: 'Compra',
    });
    const exit = await client.stockOut({ productId: product.id, quantity: 3 });
    const kardex = await client.kardex(product.id);

    expect(entry).toMatchObject({ type: 'IN', quantity: 10, stockAfter: 10 });
    expect(exit).toMatchObject({ type: 'OUT', quantity: -3, stockAfter: 7 });
    expect(kardex.data.map((m) => m.stockAfter)).toEqual([10, 7]);
  });

  it('una salida sin stock trae el detalle de la API', async () => {
    const product = api.addProduct({
      sku: 'CAB-25-100',
      name: 'Cable',
      stock: 1,
    });

    const error = await client
      .stockOut({ productId: product.id, quantity: 5 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryProblem);
    expect(error).toMatchObject({
      status: 422,
      detail: 'Stock insuficiente: hay 1 y se pidieron 5',
    });
  });
});
