import { InventoryClient } from '../../src/inventory/client.js';
import { FakeInventoryApi } from './fake-inventory-api.js';

/** API falsa con un catálogo de ferretería y un cliente del operador demo. */
export function createFakeInventory(): {
  api: FakeInventoryApi;
  client: InventoryClient;
} {
  const api = new FakeInventoryApi();
  api.addProduct({
    sku: 'MART-001',
    name: 'Martillo de carpintero 16 oz',
    price: '45.50',
    stock: 18,
    minStock: 5,
  });
  api.addProduct({
    sku: 'CAB-25-100',
    name: 'Cable THW 2,5 mm²',
    category: { id: 'c-2', name: 'Electricidad' },
    price: '310.00',
    stock: 1,
    minStock: 3,
  });
  api.addProduct({
    sku: 'PINT-LAT-4L',
    name: 'Pintura látex blanca 4 L',
    category: { id: 'c-3', name: 'Pinturas' },
    price: '120.00',
    stock: 7,
    minStock: 10,
  });
  api.addProduct({
    sku: 'DEST-002',
    name: 'Juego de destornilladores',
    price: '62.00',
    stock: 4,
    minStock: 4,
  });
  api.addProduct({
    sku: 'VIEJO-1',
    name: 'Martillo descontinuado',
    stock: 0,
    minStock: 9,
    active: false,
  });
  const client = new InventoryClient(
    {
      apiUrl: api.baseUrl,
      email: 'demo@inventario.test',
      password: 'demo-inventario-2026',
    },
    api.fetch,
  );
  return { api, client };
}
