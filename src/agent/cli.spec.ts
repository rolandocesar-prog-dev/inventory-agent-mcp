import { describe, expect, it, vi } from 'vitest';
import {
  isExit,
  isYes,
  LineQueue,
  terminalApprover,
  traceLine,
} from './cli.js';

describe('CLI del agente', () => {
  it.each([
    ['s', true],
    [' Sí ', true],
    ['si', true],
    ['S', true],
    ['n', false],
    ['', false],
    ['sip', false],
    ['yes', false],
  ])('isYes(%j) → %s', (answer, expected) => {
    expect(isYes(answer)).toBe(expected);
  });

  it('muestra el resumen del movimiento y pregunta antes de registrar', async () => {
    const question = vi.fn(() => Promise.resolve('s'));

    const approved = await terminalApprover({ question }).approve({
      tool: 'confirm_stock_movement',
      args: { code: 'ABC234' },
      summary: 'Salida de 3 × MART-001 · Martillo. Stock: 18 → 15.',
    });

    expect(approved).toBe(true);
    expect(question).toHaveBeenCalledWith(
      '\n⚠ Salida de 3 × MART-001 · Martillo. Stock: 18 → 15.\n¿Registrar? (s/n) > ',
    );
  });

  it('sin resumen muestra el código', async () => {
    const question = vi.fn(() => Promise.resolve('n'));

    const approved = await terminalApprover({ question }).approve({
      tool: 'confirm_stock_movement',
      args: { code: 'ZZZZZZ' },
    });

    expect(approved).toBe(false);
    expect(question).toHaveBeenCalledWith(
      expect.stringContaining('Movimiento con código ZZZZZZ (sin resumen)'),
    );
  });

  it('describe cada llamada de herramienta', () => {
    expect(
      traceLine({
        tool: 'get_product',
        args: { sku: 'MART-001' },
        isError: false,
      }),
    ).toBe('  · get_product {"sku":"MART-001"}');
    expect(
      traceLine({
        tool: 'confirm_stock_movement',
        args: { code: 'ABC234' },
        isError: false,
        approved: false,
      }),
    ).toBe('  · confirm_stock_movement {"code":"ABC234"} (no aprobado)');
    expect(
      traceLine({
        tool: 'confirm_stock_movement',
        args: {},
        isError: true,
        approved: true,
      }),
    ).toBe('  · confirm_stock_movement {} (error, aprobado)');
  });

  it.each([
    ['salir', true],
    [' Exit ', true],
    ['quit', true],
    ['salir ahora', false],
  ])('isExit(%j) → %s', (text, expected) => {
    expect(isExit(text)).toBe(expected);
  });

  it('si la entrada terminó, no aprueba', async () => {
    const approved = await terminalApprover({
      question: () => Promise.resolve(null),
    }).approve({ tool: 'confirm_stock_movement', args: {} });

    expect(approved).toBe(false);
  });
});

describe('LineQueue', () => {
  it('no pierde las líneas que llegan antes de preguntar', async () => {
    const out: string[] = [];
    const queue = new LineQueue((text) => out.push(text));
    queue.push('primera');
    queue.push('segunda');

    await expect(queue.question('> ')).resolves.toBe('primera');
    await expect(queue.question('> ')).resolves.toBe('segunda');
    expect(out).toEqual(['> ', '> ']);
  });

  it('espera la siguiente línea si todavía no llegó', async () => {
    const queue = new LineQueue(() => undefined);

    const pending = queue.question('> ');
    queue.push('tarde');

    await expect(pending).resolves.toBe('tarde');
  });

  it('con eco repite la línea leída (entrada redirigida)', async () => {
    const out: string[] = [];
    const queue = new LineQueue((text) => out.push(text), true);
    queue.push('hola');

    await queue.question('> ');
    const pending = queue.question('> ');
    queue.push('chau');
    await pending;

    expect(out).toEqual(['> ', 'hola\n', '> ', 'chau\n']);
  });

  it('al cerrarse responde null a quien espera y a las preguntas nuevas', async () => {
    const queue = new LineQueue(() => undefined);
    const pending = queue.question('> ');

    queue.close();

    await expect(pending).resolves.toBeNull();
    await expect(queue.question('> ')).resolves.toBeNull();
  });
});
