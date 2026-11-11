import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeInventoryApi } from '../../test/support/fake-inventory-api.js';
import { InventoryClient } from './client.js';
import {
  InventoryAuthError,
  InventoryProblem,
  InventoryUnavailable,
} from './errors.js';

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

describe('InventoryClient (sesión y errores)', () => {
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

  it('inicia sesión al primer uso y reutiliza el token', async () => {
    await client.me();
    await client.me();

    expect(api.calls).toEqual([
      'POST /auth/login',
      'GET /auth/me',
      'GET /auth/me',
    ]);
  });

  it('varias peticiones simultáneas comparten un solo login', async () => {
    await Promise.all([client.me(), client.me(), client.me()]);

    expect(api.calls.filter((c) => c === 'POST /auth/login')).toHaveLength(1);
  });

  it('ante un 401 renueva el token y repite la petición una vez', async () => {
    await client.me();
    api.expireAccessTokens();

    await expect(client.me()).resolves.toMatchObject({ role: 'OPERATOR' });
    expect(api.calls.slice(2)).toEqual([
      'GET /auth/me',
      'POST /auth/refresh',
      'GET /auth/me',
    ]);
  });

  it('varios 401 simultáneos comparten una sola renovación', async () => {
    await client.me();
    api.expireAccessTokens();

    await Promise.all([client.me(), client.me(), client.me()]);

    expect(api.calls.filter((c) => c === 'POST /auth/refresh')).toHaveLength(1);
    expect(api.calls.filter((c) => c === 'POST /auth/login')).toHaveLength(1);
  });

  it('si el token de renovación ya no sirve, vuelve a iniciar sesión', async () => {
    await client.me();
    api.expireAccessTokens();
    api.refreshTokens.clear();

    await expect(client.me()).resolves.toMatchObject({ role: 'OPERATOR' });
    expect(api.calls.slice(-3)).toEqual([
      'POST /auth/refresh',
      'POST /auth/login',
      'GET /auth/me',
    ]);
  });

  it('si la sesión sigue rechazada tras renovar, lanza InventoryAuthError', async () => {
    await client.me();
    const original = api.fetch;
    const always401 = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await original(input, init);
        return urlOf(input).endsWith('/auth/me')
          ? new Response('{}', { status: 401 })
          : response;
      },
    );
    const stubborn = new InventoryClient(
      {
        apiUrl: api.baseUrl,
        email: 'demo@inventario.test',
        password: 'demo-inventario-2026',
      },
      always401,
    );

    await expect(stubborn.me()).rejects.toBeInstanceOf(InventoryAuthError);
  });

  it('credenciales inválidas: InventoryAuthError sin mostrar la contraseña', async () => {
    const wrong = new InventoryClient(
      {
        apiUrl: api.baseUrl,
        email: 'demo@inventario.test',
        password: 'mala-clave',
      },
      api.fetch,
    );

    const error = await wrong.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InventoryAuthError);
    expect(String(error)).not.toContain('mala-clave');
  });

  it('traduce los problem details de la API', async () => {
    const error = await new InventoryClient(
      {
        apiUrl: api.baseUrl,
        email: 'demo@inventario.test',
        password: 'demo-inventario-2026',
      },
      async (input, init) => {
        if (urlOf(input).endsWith('/auth/login')) return api.fetch(input, init);
        return new Response(
          JSON.stringify({
            title: 'Prohibido',
            status: 403,
            detail: 'Tu rol no permite esta operación',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        );
      },
    )
      .me()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryProblem);
    expect(error).toMatchObject({
      status: 403,
      detail: 'Tu rol no permite esta operación',
    });
  });

  it.each([
    [
      '500 sin detalles internos',
      new Response('stack trace secreto', { status: 500 }),
      InventoryProblem,
    ],
    ['503', new Response('', { status: 503 }), InventoryUnavailable],
    [
      'cuerpo que no es JSON',
      new Response('<html>', { status: 404, statusText: 'Not Found' }),
      InventoryProblem,
    ],
  ])('errores de la API: %s', async (_caso, failure, type) => {
    const client503 = new InventoryClient(
      {
        apiUrl: api.baseUrl,
        email: 'demo@inventario.test',
        password: 'demo-inventario-2026',
      },
      async (input, init) =>
        urlOf(input).endsWith('/auth/login') ? api.fetch(input, init) : failure,
    );

    const error = await client503.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(String((error as Error).message)).not.toContain('secreto');
  });

  it('si la red falla, lanza InventoryUnavailable', async () => {
    api.down = true;

    await expect(client.me()).rejects.toBeInstanceOf(InventoryUnavailable);
  });
});
