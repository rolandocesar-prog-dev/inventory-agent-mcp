import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, parseScenarios } from './scenarios.js';

/** SKUs del catálogo de demostración de la API de inventario (src/demo/seed-demo.ts). */
const DEMO_SKUS = [
  'MART-001',
  'DEST-002',
  'TAL-010',
  'PINT-LAT-4L',
  'ROD-009',
  'CAB-25-100',
  'FOCO-LED-9',
  'TOR-8-100',
];
const TOOLS = [
  'search_products',
  'get_product',
  'low_stock_products',
  'product_movements',
  'prepare_stock_movement',
  'confirm_stock_movement',
];

describe('eval/scenarios.jsonl', () => {
  const scenarios = parseScenarios(
    readFileSync('eval/scenarios.jsonl', 'utf8'),
  );

  it('cubre todas las categorías', () => {
    expect(new Set(scenarios.map((s) => s.category))).toEqual(
      new Set(CATEGORIES),
    );
  });

  it('solo menciona herramientas y SKUs que existen', () => {
    for (const s of scenarios) {
      for (const option of s.tools.flatMap((t) => t.split('|'))) {
        expect(TOOLS, s.id).toContain(option);
      }
      for (const sku of Object.keys(s.stock ?? {})) {
        expect(DEMO_SKUS, s.id).toContain(sku);
      }
    }
  });

  it('los movimientos esperan cambio de stock; el resto, ninguno', () => {
    for (const s of scenarios) {
      const changes = Object.values(s.stock ?? {});
      if (s.category === 'movimiento') {
        expect(changes.length, s.id).toBe(1);
        expect(s.approve, s.id).toBe(true);
      } else if (s.category !== 'consulta') {
        expect(s.stock, s.id).toEqual({});
      }
    }
  });

  it('el rechazo humano es el único que no aprueba', () => {
    for (const s of scenarios) {
      expect(s.approve, s.id).toBe(s.category !== 'rechazo-humano');
    }
  });
});

describe('parseScenarios', () => {
  it('ignora líneas vacías y aplica valores por defecto', () => {
    const [s] = parseScenarios(
      '\n{"id":"x01","category":"consulta","message":"hola","tools":[]}\n',
    );

    expect(s).toEqual({
      id: 'x01',
      category: 'consulta',
      message: 'hola',
      approve: true,
      tools: [],
    });
  });

  it('indica la línea de un escenario inválido', () => {
    expect(() =>
      parseScenarios(
        '{"id":"x01","category":"otra","message":"hola","tools":[]}',
      ),
    ).toThrow(/línea 1: category/);
  });

  it('rechaza ids repetidos', () => {
    const line =
      '{"id":"x01","category":"consulta","message":"hola","tools":[]}';

    expect(() => parseScenarios(`${line}\n${line}`)).toThrow(/repetidos: x01/);
  });
});
