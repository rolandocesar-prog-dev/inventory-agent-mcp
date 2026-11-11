import type { Movement, Product } from '../inventory/types.js';

const MOVEMENT_NAMES = {
  IN: 'Entrada',
  OUT: 'Salida',
  ADJUSTMENT: 'Ajuste',
} as const;

/** «MART-001 · Martillo · stock 18 (mínimo 5) · precio 45.50» */
export function productLine(product: Product): string {
  return `${product.sku} · ${product.name} · stock ${product.stock} (mínimo ${product.minStock}) · precio ${product.price}`;
}

export function productSummary(product: Product): Record<string, unknown> {
  return {
    sku: product.sku,
    name: product.name,
    category: product.category.name,
    price: product.price,
    stock: product.stock,
    minStock: product.minStock,
  };
}

/** «2026-11-10 14:03 UTC · Salida −3 → 15 · Venta mostrador · demo@inventario.test» */
export function movementLine(movement: Movement): string {
  const when = `${movement.createdAt.slice(0, 16).replace('T', ' ')} UTC`;
  const sign = movement.quantity > 0 ? '+' : '−';
  const reason = movement.reason ? ` · ${movement.reason}` : '';
  return `${when} · ${MOVEMENT_NAMES[movement.type]} ${sign}${Math.abs(movement.quantity)} → ${movement.stockAfter}${reason} · ${movement.user.email}`;
}

/** SKU como lo guarda la API: sin espacios y en mayúsculas. */
export function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}
