import type { Movement, Product, Role } from '../../src/inventory/types.js';

interface FakeUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

type Json = Record<string, unknown> | unknown[];

const problem = (status: number, title: string, detail: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title, status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let ids = 0;
const nextId = (prefix: string) =>
  `${prefix}-${String(++ids).padStart(4, '0')}`;

/**
 * API de inventario falsa en memoria con el mismo contrato que la real
 * (rutas, paginación, errores RFC 9457 y tokens). `fetch` se pasa al cliente.
 */
export class FakeInventoryApi {
  readonly baseUrl = 'http://inventario.test/api/v1';
  readonly users: FakeUser[] = [
    {
      id: 'u-op',
      email: 'demo@inventario.test',
      password: 'demo-inventario-2026',
      role: 'OPERATOR',
    },
    {
      id: 'u-admin',
      email: 'admin@inventario.test',
      password: 'clave-admin',
      role: 'ADMIN',
    },
  ];
  readonly products: Product[] = [];
  readonly movements: Movement[] = [];
  readonly calls: string[] = [];
  /** Tokens de acceso válidos; vaciarlo simula que expiraron. */
  readonly accessTokens = new Map<string, string>();
  readonly refreshTokens = new Map<string, string>();
  down = false;

  addProduct(
    partial: Partial<Product> & Pick<Product, 'sku' | 'name'>,
  ): Product {
    const product: Product = {
      id: nextId('p'),
      category: { id: 'c-1', name: 'Herramientas' },
      price: '10.00',
      stock: 0,
      minStock: 0,
      active: true,
      ...partial,
    };
    this.products.push(product);
    return product;
  }

  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    this.calls.push(`${method} ${path}`);
    const body = init?.body
      ? (JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >)
      : {};

    if (method === 'POST' && path === '/auth/login') return this.login(body);
    if (method === 'POST' && path === '/auth/refresh')
      return this.refresh(body);

    const header = new Headers(init?.headers).get('Authorization') ?? '';
    const userId = this.accessTokens.get(header.replace('Bearer ', ''));
    const user = this.users.find((u) => u.id === userId);
    if (!user)
      return problem(401, 'No autenticado', 'Token de acceso inválido');

    if (method === 'GET' && path === '/auth/me') {
      return json({
        id: user.id,
        email: user.email,
        role: user.role,
        active: true,
      });
    }
    if (method === 'GET' && path === '/products') return this.list(url);
    const kardex = /^\/products\/([^/]+)\/movements$/.exec(path);
    if (method === 'GET' && kardex) return this.kardex(kardex[1] ?? '', url);
    if (method === 'POST' && (path === '/stock/in' || path === '/stock/out')) {
      return this.move(path === '/stock/in' ? 'IN' : 'OUT', body, user);
    }
    return problem(404, 'No encontrado', `Ruta ${method} ${path}`);
  };

  private issue(userId: string): Response {
    const access = nextId('access');
    const refresh = nextId('refresh');
    this.accessTokens.set(access, userId);
    this.refreshTokens.set(refresh, userId);
    return json({
      tokenType: 'Bearer',
      accessToken: access,
      expiresIn: 900,
      refreshToken: refresh,
    });
  }

  private login(body: Record<string, unknown>): Response {
    const user = this.users.find(
      (u) => u.email === body['email'] && u.password === body['password'],
    );
    return user
      ? this.issue(user.id)
      : problem(401, 'No autenticado', 'Correo o contraseña incorrectos');
  }

  private refresh(body: Record<string, unknown>): Response {
    const token = String(body['refreshToken']);
    const userId = this.refreshTokens.get(token);
    if (!userId)
      return problem(401, 'No autenticado', 'Sesión inválida o expirada');
    this.refreshTokens.delete(token);
    return this.issue(userId);
  }

  private list(url: URL): Response {
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    const search = url.searchParams.get('search')?.toLowerCase();
    const filtered = this.products
      .filter((p) => p.active)
      .filter(
        (p) =>
          !search ||
          p.name.toLowerCase().includes(search) ||
          p.sku.toLowerCase().includes(search),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({
      data: filtered.slice((page - 1) * pageSize, page * pageSize),
      meta: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / pageSize),
      },
    });
  }

  private kardex(productId: string, url: URL): Response {
    if (!this.products.some((p) => p.id === productId)) {
      return problem(404, 'No encontrado', 'Producto no encontrado');
    }
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const data = this.movements.filter(
      (m) =>
        m.productId === productId &&
        (!from || m.createdAt >= from) &&
        (!to || m.createdAt <= `${to}T23:59:59.999Z`),
    );
    return json({
      data,
      meta: { page: 1, pageSize: 100, total: data.length, totalPages: 1 },
    });
  }

  private move(
    type: 'IN' | 'OUT',
    body: Record<string, unknown>,
    user: FakeUser,
  ): Response {
    const product = this.products.find((p) => p.id === body['productId']);
    const quantity = Number(body['quantity']);
    if (!product)
      return problem(404, 'No encontrado', 'Producto no encontrado');
    if (!product.active) {
      return problem(
        422,
        'No se puede procesar',
        'El producto está desactivado: no admite movimientos',
      );
    }
    if (type === 'OUT' && product.stock < quantity) {
      return problem(
        422,
        'No se puede procesar',
        `Stock insuficiente: hay ${product.stock} y se pidieron ${quantity}`,
      );
    }
    product.stock += type === 'IN' ? quantity : -quantity;
    const movement: Movement = {
      id: nextId('m'),
      productId: product.id,
      type,
      quantity: type === 'IN' ? quantity : -quantity,
      stockAfter: product.stock,
      reason: typeof body['reason'] === 'string' ? body['reason'] : null,
      user: { id: user.id, email: user.email },
      createdAt: new Date().toISOString(),
    };
    this.movements.push(movement);
    return json(movement as unknown as Json, 201);
  }
}
