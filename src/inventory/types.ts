/** Tipos de las respuestas de la API de inventario (inventory-api-nestjs, /api/v1). */

export type Role = 'ADMIN' | 'OPERATOR';
export type MovementType = 'IN' | 'OUT' | 'ADJUSTMENT';

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface User {
  id: string;
  email: string;
  role: Role;
  active: boolean;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: { id: string; name: string };
  /** Texto con 2 decimales, p. ej. "45.50". */
  price: string;
  stock: number;
  minStock: number;
  active: boolean;
}

export interface Movement {
  id: string;
  productId: string;
  type: MovementType;
  /** Con signo: + entra, − sale. */
  quantity: number;
  stockAfter: number;
  reason: string | null;
  user: { id: string; email: string };
  createdAt: string;
}

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}
