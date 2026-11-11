import type { InventoryConfig } from '../config.js';
import {
  InventoryAuthError,
  InventoryProblem,
  InventoryUnavailable,
} from './errors.js';
import type { Movement, Page, Product, TokenPair, User } from './types.js';

export type FetchFn = typeof fetch;

/** Render gratuito puede tardar cerca de un minuto en despertar. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Máximo de la API para pageSize. */
export const MAX_PAGE_SIZE = 100;

export interface StockMovementInput {
  productId: string;
  quantity: number;
  reason?: string;
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
}

/**
 * Cliente HTTP de la API de inventario (specs/design.md §3). Inicia sesión al
 * primer uso, renueva el token ante un 401 y repite la petición una vez, y
 * convierte los errores en `InventoryProblem` / `InventoryUnavailable`.
 */
export class InventoryClient {
  private tokens: TokenPair | null = null;
  private pendingLogin: Promise<TokenPair> | null = null;
  private pendingRenew: Promise<TokenPair> | null = null;

  constructor(
    private readonly config: InventoryConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** Usuario de la cuenta configurada; el servidor exige que sea operador. */
  me(): Promise<User> {
    return this.request<User>('GET', '/auth/me');
  }

  /** Productos activos cuyo nombre o SKU contiene `query`, ordenados por nombre. */
  searchProducts(
    query?: string,
    page = 1,
    pageSize = 20,
  ): Promise<Page<Product>> {
    return this.request<Page<Product>>('GET', '/products', {
      query: { search: query || undefined, page, pageSize },
    });
  }

  /** Todo el catálogo activo, recorriendo las páginas de 100. */
  async listAllProducts(): Promise<Product[]> {
    const products: Product[] = [];
    for (let page = 1; ; page++) {
      const result = await this.searchProducts(undefined, page, MAX_PAGE_SIZE);
      products.push(...result.data);
      if (page >= result.meta.totalPages) return products;
    }
  }

  /** Kardex de un producto; `from` y `to` en AAAA-MM-DD (inclusivos). */
  kardex(
    productId: string,
    from?: string,
    to?: string,
  ): Promise<Page<Movement>> {
    return this.request<Page<Movement>>(
      'GET',
      `/products/${encodeURIComponent(productId)}/movements`,
      { query: { from, to, pageSize: MAX_PAGE_SIZE } },
    );
  }

  stockIn(movement: StockMovementInput): Promise<Movement> {
    return this.request<Movement>('POST', '/stock/in', { body: movement });
  }

  stockOut(movement: StockMovementInput): Promise<Movement> {
    return this.request<Movement>('POST', '/stock/out', { body: movement });
  }
  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const tokens = await this.session();
    let response = await this.send(method, path, options, tokens.accessToken);
    if (response.status === 401) {
      const renewed = await this.renew(tokens);
      response = await this.send(method, path, options, renewed.accessToken);
      if (response.status === 401) {
        this.tokens = null;
        throw new InventoryAuthError(
          'La sesión con la API de inventario no es válida.',
        );
      }
    }
    return this.parse<T>(response);
  }

  private session(): Promise<TokenPair> {
    if (this.tokens) return Promise.resolve(this.tokens);
    // Varias herramientas a la vez comparten un solo login.
    this.pendingLogin ??= this.login().finally(() => {
      this.pendingLogin = null;
    });
    return this.pendingLogin;
  }

  private async login(): Promise<TokenPair> {
    const response = await this.send('POST', '/auth/login', {
      body: { email: this.config.email, password: this.config.password },
    });
    if (response.status === 401) {
      throw new InventoryAuthError(
        'La cuenta configurada no pudo iniciar sesión en la API de inventario.',
      );
    }
    this.tokens = await this.parse<TokenPair>(response);
    return this.tokens;
  }

  /**
   * Renueva con el token de renovación (de un solo uso en la API): las
   * peticiones que reciben 401 a la vez comparten una sola renovación. Si el
   * token ya no sirve, inicia sesión de nuevo.
   */
  private renew(stale: TokenPair): Promise<TokenPair> {
    if (this.tokens && this.tokens !== stale)
      return Promise.resolve(this.tokens);
    this.pendingRenew ??= this.refresh(stale).finally(() => {
      this.pendingRenew = null;
    });
    return this.pendingRenew;
  }

  private async refresh(stale: TokenPair): Promise<TokenPair> {
    const response = await this.send('POST', '/auth/refresh', {
      body: { refreshToken: stale.refreshToken },
    });
    if (response.ok) {
      this.tokens = (await response.json()) as TokenPair;
      return this.tokens;
    }
    this.tokens = null;
    return this.session();
  }
  private async send(
    method: string,
    path: string,
    { body, query }: RequestOptions,
    accessToken?: string,
  ): Promise<Response> {
    const url = new URL(`${this.config.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    try {
      return await this.fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new InventoryUnavailable();
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return response.status === 204
        ? (undefined as T)
        : ((await response.json()) as T);
    }
    throw await toProblem(response);
  }
}

async function toProblem(response: Response): Promise<Error> {
  if (response.status >= 500 && response.status !== 503) {
    return new InventoryProblem(
      response.status,
      'Error del servidor',
      'La API de inventario tuvo un error interno.',
    );
  }
  if (response.status === 503) return new InventoryUnavailable();
  try {
    const body = (await response.json()) as Partial<{
      title: string;
      detail: string;
    }>;
    return new InventoryProblem(
      response.status,
      body.title ?? response.statusText,
      body.detail ?? body.title ?? `Error ${response.status}`,
    );
  } catch {
    return new InventoryProblem(
      response.status,
      response.statusText,
      `La API de inventario respondió ${response.status}.`,
    );
  }
}
