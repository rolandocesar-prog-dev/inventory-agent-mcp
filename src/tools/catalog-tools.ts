import { z } from 'zod';
import type { InventoryClient } from '../inventory/client.js';
import type { Product } from '../inventory/types.js';
import {
  movementLine,
  normalizeSku,
  productLine,
  productSummary,
} from './format.js';
import { defineTool, ToolError, type Tool } from './tool.js';

/** Lo que las herramientas necesitan de la API (facilita las pruebas). */
export type CatalogApi = Pick<
  InventoryClient,
  'searchProducts' | 'listAllProducts' | 'kardex'
>;

/** Máximo de movimientos que se muestran como texto al modelo. */
export const KARDEX_TEXT_LIMIT = 20;

const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .describe('SKU exacto del producto, p. ej. MART-001');
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD');

/** La API no filtra por SKU exacto: se busca y se toma la coincidencia exacta. */
export async function findBySku(
  api: Pick<CatalogApi, 'searchProducts'>,
  sku: string,
): Promise<Product> {
  const wanted = normalizeSku(sku);
  const { data } = await api.searchProducts(wanted, 1, 100);
  const product = data.find((p) => p.sku === wanted);
  if (!product) {
    throw new ToolError(
      `No existe un producto activo con el SKU ${wanted}. Búscalo por nombre con search_products.`,
    );
  }
  return product;
}

export function catalogTools(api: CatalogApi): Tool[] {
  return [
    defineTool({
      name: 'search_products',
      title: 'Buscar productos',
      description:
        'Busca productos activos por nombre o SKU (sin texto, lista el catálogo). Devuelve SKU, nombre, stock, stock mínimo y precio. Úsala para saber cuánto queda de algo o para encontrar el SKU.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .max(100)
          .optional()
          .describe('Parte del nombre o del SKU, p. ej. "martillo"'),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Página (20 por página)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler({ query, page = 1 }) {
        const result = await api.searchProducts(query, page);
        if (result.meta.total === 0) {
          return {
            text: query
              ? `No hay productos que coincidan con «${query}».`
              : 'El catálogo está vacío.',
            data: { products: [], total: 0 },
          };
        }
        const header = `${result.meta.total} producto(s); página ${result.meta.page} de ${result.meta.totalPages}:`;
        return {
          text: [header, ...result.data.map(productLine)].join('\n'),
          data: {
            products: result.data.map(productSummary),
            ...result.meta,
          },
        };
      },
    }),

    defineTool({
      name: 'get_product',
      title: 'Ver un producto',
      description:
        'Muestra el detalle de un producto por su SKU exacto: categoría, precio, stock y stock mínimo.',
      inputSchema: { sku: skuSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler({ sku }) {
        const product = await findBySku(api, sku);
        return {
          text: `${productLine(product)} · categoría ${product.category.name}`,
          data: productSummary(product),
        };
      },
    }),

    defineTool({
      name: 'low_stock_products',
      title: 'Productos por agotarse',
      description:
        'Lista los productos activos con stock igual o menor a su stock mínimo, los más urgentes primero.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler() {
        // El reporte de la API es solo para admin: se calcula sobre el catálogo (design §3).
        const low = (await api.listAllProducts())
          .filter((p) => p.stock <= p.minStock)
          .map((p) => ({ product: p, missing: p.minStock - p.stock }))
          .sort(
            (a, b) =>
              b.missing - a.missing ||
              a.product.name.localeCompare(b.product.name, 'es'),
          );
        if (low.length === 0) {
          return {
            text: 'Ningún producto está en su stock mínimo o por debajo.',
            data: { products: [] },
          };
        }
        return {
          text: [
            `${low.length} producto(s) en su stock mínimo o por debajo:`,
            ...low.map(
              ({ product, missing }) =>
                `${productLine(product)} · faltan ${missing} para el mínimo`,
            ),
          ].join('\n'),
          data: {
            products: low.map(({ product, missing }) => ({
              ...productSummary(product),
              missing,
            })),
          },
        };
      },
    }),

    defineTool({
      name: 'product_movements',
      title: 'Historial de un producto',
      description:
        'Muestra el kardex (entradas, salidas y ajustes con fecha, cantidad, stock resultante, motivo y usuario) de un producto por SKU, opcionalmente entre dos fechas AAAA-MM-DD.',
      inputSchema: {
        sku: skuSchema,
        from: dateSchema.optional().describe('Desde (inclusive), AAAA-MM-DD'),
        to: dateSchema.optional().describe('Hasta (inclusive), AAAA-MM-DD'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler({ sku, from, to }) {
        const product = await findBySku(api, sku);
        const { data, meta } = await api.kardex(product.id, from, to);
        if (data.length === 0) {
          return {
            text: `${product.sku} no tiene movimientos en ese período.`,
            data: { sku: product.sku, movements: [] },
          };
        }
        const shown = data.slice(-KARDEX_TEXT_LIMIT);
        const note =
          meta.total > shown.length
            ? ` (muestro los ${shown.length} más recientes de ${meta.total})`
            : '';
        return {
          text: [
            `Movimientos de ${product.sku} · ${product.name}${note}:`,
            ...shown.map(movementLine),
            `Stock actual: ${product.stock}`,
          ].join('\n'),
          data: { sku: product.sku, total: meta.total, movements: data },
        };
      },
    }),
  ];
}
