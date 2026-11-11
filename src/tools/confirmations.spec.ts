import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CONFIRMATION_TTL_MS,
  ConfirmationStore,
  MAX_PENDING,
  type PendingMovement,
} from './confirmations.js';
import { ToolError } from './tool.js';

const movement: PendingMovement = {
  type: 'out',
  productId: 'p-1',
  sku: 'MART-001',
  name: 'Martillo',
  quantity: 3,
  stockBefore: 18,
  stockAfter: 15,
};

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ConfirmationStore', () => {
  it('emite códigos de 6 caracteres sin letras ni números ambiguos', () => {
    const store = new ConfirmationStore();

    for (let i = 0; i < 50; i++) {
      const code = store.issue(movement);
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]+$`));
      expect(code).not.toMatch(/[01IO]/);
    }
  });

  it('el código es de un solo uso', () => {
    const store = new ConfirmationStore();
    const code = store.issue(movement);

    expect(store.take(code)).toEqual(movement);
    expect(() => store.take(code)).toThrow(/no existe o ya se usó/);
  });

  it('acepta el código sin distinguir mayúsculas ni espacios', () => {
    const store = new ConfirmationStore();
    const code = store.issue(movement);

    expect(store.take(` ${code.toLowerCase()} `)).toEqual(movement);
  });

  it('un código inventado no sirve', () => {
    expect(() => new ConfirmationStore().take('ABCDEF')).toThrow(ToolError);
  });

  it('vence a los 5 minutos', () => {
    const time = clock();
    const store = new ConfirmationStore(time.now);
    const fresh = store.issue(movement);
    const stale = store.issue(movement);

    time.advance(CONFIRMATION_TTL_MS - 1);
    expect(store.take(fresh)).toEqual(movement);

    time.advance(1);
    expect(store.peek(stale)).toBeUndefined();
    expect(() => store.take(stale)).toThrow(/venció/);
  });

  it('peek muestra el pedido sin consumirlo', () => {
    const store = new ConfirmationStore();
    const code = store.issue(movement);

    expect(store.peek(code)).toEqual(movement);
    expect(store.take(code)).toEqual(movement);
  });

  it('descarta los vencidos y limita los pendientes en memoria', () => {
    const time = clock();
    const store = new ConfirmationStore(time.now);
    store.issue(movement);
    time.advance(CONFIRMATION_TTL_MS);

    store.issue(movement);
    expect(store.size).toBe(1);

    for (let i = 0; i < MAX_PENDING + 10; i++) store.issue(movement);
    expect(store.size).toBe(MAX_PENDING);
  });

  it('no repite un código pendiente aunque el azar coincida', () => {
    const sequence = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    const store = new ConfirmationStore(Date.now, () => sequence.shift() ?? 2);

    const first = store.issue(movement);
    const second = store.issue(movement);

    expect(first).toBe('AAAAAA');
    expect(second).toBe('BBBBBB');
  });
});
