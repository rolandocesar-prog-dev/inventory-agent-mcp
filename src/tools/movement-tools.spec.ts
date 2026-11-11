import { beforeEach, describe, expect, it } from 'vitest';
import type { FakeInventoryApi } from '../../test/support/fake-inventory-api.js';
import { createFakeInventory } from '../../test/support/setup.js';
import { CONFIRMATION_TTL_MS, ConfirmationStore } from './confirmations.js';
import {
  AGENT_REASON_SUFFIX,
  CONFIRM_TOOL,
  movementTools,
  PREPARE_TOOL,
} from './movement-tools.js';
import type { Tool } from './tool.js';

describe('herramientas de movimientos', () => {
  let api: FakeInventoryApi;
  let prepare: Tool;
  let confirm: Tool;
  let now: number;

  const stockOf = (sku: string) =>
    api.products.find((p) => p.sku === sku)?.stock;

  beforeEach(() => {
    let client;
    ({ api, client } = createFakeInventory());
    now = 1_000_000;
    const tools = movementTools(client, new ConfirmationStore(() => now));
    [prepare, confirm] = tools as [Tool, Tool];
  });

  it('preparar es de solo lectura y confirmar es destructiva', () => {
    expect(prepare.name).toBe(PREPARE_TOOL);
    expect(prepare.annotations).toMatchObject({ readOnlyHint: true });
    expect(confirm.name).toBe(CONFIRM_TOOL);
    expect(confirm.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('preparar no modifica el inventario y devuelve resumen y código', async () => {
    const result = await prepare.run({
      type: 'out',
      sku: 'mart-001',
      quantity: 3,
      reason: 'Venta mostrador',
    });

    expect(stockOf('MART-001')).toBe(18);
    expect(api.calls.some((c) => c.startsWith('POST /stock'))).toBe(false);
    expect(result.text).toContain(
      'SIN registrar: Salida de 3 × MART-001 · Martillo de carpintero 16 oz',
    );
    expect(result.text).toContain('Stock: 18 → 15.');
    expect(result.data).toMatchObject({
      sku: 'MART-001',
      stockBefore: 18,
      stockAfter: 15,
      code: expect.stringMatching(/^[A-Z2-9]{6}$/),
    });
  });

  it('confirmar registra el movimiento con el motivo marcado como del agente', async () => {
    const prepared = await prepare.run({
      type: 'out',
      sku: 'MART-001',
      quantity: 3,
      reason: 'Venta mostrador',
    });

    const result = await confirm.run({ code: prepared.data?.['code'] });

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe(
      'Registrado: Salida de 3 × MART-001 · Martillo de carpintero 16 oz. Stock actual de MART-001: 15.',
    );
    expect(stockOf('MART-001')).toBe(15);
    expect(api.movements.at(-1)?.reason).toBe(
      `Venta mostrador ${AGENT_REASON_SUFFIX}`,
    );
  });

  it('una entrada sin motivo usa «Entrada (vía agente)»', async () => {
    const prepared = await prepare.run({
      type: 'in',
      sku: 'CAB-25-100',
      quantity: 10,
    });

    await confirm.run({ code: prepared.data?.['code'] });

    expect(prepared.text).toContain('Stock: 1 → 11.');
    expect(stockOf('CAB-25-100')).toBe(11);
    expect(api.movements.at(-1)?.reason).toBe(`Entrada ${AGENT_REASON_SUFFIX}`);
  });

  it('una salida mayor al stock no emite código', async () => {
    const result = await prepare.run({
      type: 'out',
      sku: 'CAB-25-100',
      quantity: 5,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.text).toBe(
      'No alcanza: hay 1 de CAB-25-100 y pediste 5. No se preparó ningún movimiento.',
    );
    expect(result.data).toBeUndefined();
  });

  it('el código sirve una sola vez', async () => {
    const prepared = await prepare.run({
      type: 'in',
      sku: 'MART-001',
      quantity: 1,
    });
    const code = prepared.data?.['code'];

    await confirm.run({ code });
    const again = await confirm.run({ code });

    expect(again).toMatchObject({ isError: true });
    expect(stockOf('MART-001')).toBe(19);
  });

  it('un código vencido o inventado no registra nada', async () => {
    const prepared = await prepare.run({
      type: 'in',
      sku: 'MART-001',
      quantity: 1,
    });
    now += CONFIRMATION_TTL_MS;

    const expired = await confirm.run({ code: prepared.data?.['code'] });
    const invented = await confirm.run({ code: 'ZZZZZZ' });

    expect(expired.text).toContain('venció');
    expect(invented.text).toContain('no existe o ya se usó');
    expect(stockOf('MART-001')).toBe(18);
  });

  it('si el stock cambió entre ambos pasos, informa el 422 de la API', async () => {
    const prepared = await prepare.run({
      type: 'out',
      sku: 'CAB-25-100',
      quantity: 1,
    });
    // Otra persona vende el último cable mientras tanto.
    const cable = api.products.find((p) => p.sku === 'CAB-25-100');
    if (cable) cable.stock = 0;

    const result = await confirm.run({ code: prepared.data?.['code'] });

    expect(result).toMatchObject({ isError: true });
    expect(result.text).toBe(
      'La API de inventario rechazó la operación: Stock insuficiente: hay 0 y se pidieron 1',
    );
  });

  it.each([
    [{ type: 'adjust', sku: 'MART-001', quantity: 1 }, 'type'],
    [{ type: 'in', sku: 'MART-001', quantity: 0 }, 'quantity'],
    [{ type: 'in', sku: 'MART-001', quantity: 1.5 }, 'quantity'],
  ])('rechaza datos inválidos %#', async (args, field) => {
    const result = await prepare.run(args);

    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain(field);
  });
});
