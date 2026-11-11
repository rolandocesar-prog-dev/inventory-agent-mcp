import { z } from 'zod';
import type { InventoryClient } from '../inventory/client.js';
import { findBySku } from './catalog-tools.js';
import type { ConfirmationStore, PendingMovement } from './confirmations.js';
import { normalizeSku } from './format.js';
import { defineTool, ToolError, type Tool } from './tool.js';

export type MovementApi = Pick<
  InventoryClient,
  'searchProducts' | 'stockIn' | 'stockOut'
>;

export const PREPARE_TOOL = 'prepare_stock_movement';
export const CONFIRM_TOOL = 'confirm_stock_movement';
/** Sufijo del motivo: el kardex muestra que el movimiento vino del agente. */
export const AGENT_REASON_SUFFIX = '(vía agente)';

const TYPE_NAMES = { in: 'Entrada', out: 'Salida' } as const;

/** «Salida de 3 × MART-001 · Martillo» */
export function describeMovement(m: PendingMovement): string {
  return `${TYPE_NAMES[m.type]} de ${m.quantity} × ${m.sku} · ${m.name}`;
}

export function movementTools(
  api: MovementApi,
  confirmations: ConfirmationStore,
): Tool[] {
  return [
    defineTool({
      name: PREPARE_TOOL,
      title: 'Preparar un movimiento de stock',
      description:
        'Paso 1 de 2 para registrar una entrada (compra, devolución) o una salida (venta, consumo). Valida el pedido y devuelve un resumen con un código de confirmación; NO modifica el inventario. Muestra el resumen al usuario y, solo si lo aprueba, llama a confirm_stock_movement con el código.',
      inputSchema: {
        type: z
          .enum(['in', 'out'])
          .describe(
            'in = entrada de mercadería; out = salida (venta o consumo)',
          ),
        sku: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .describe('SKU exacto del producto, p. ej. MART-001'),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .describe('Unidades, entero mayor que 0'),
        reason: z
          .string()
          .trim()
          .max(150)
          .optional()
          .describe('Motivo breve, p. ej. "Venta mostrador"'),
      },
      // Solo valida y reserva un código: el inventario no cambia.
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler({ type, sku, quantity, reason }) {
        const product = await findBySku(api, sku);
        if (type === 'out' && quantity > product.stock) {
          throw new ToolError(
            `No alcanza: hay ${product.stock} de ${product.sku} y pediste ${quantity}. No se preparó ningún movimiento.`,
          );
        }
        const pending: PendingMovement = {
          type,
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity,
          ...(reason ? { reason } : {}),
          stockBefore: product.stock,
          stockAfter:
            type === 'in' ? product.stock + quantity : product.stock - quantity,
        };
        const code = confirmations.issue(pending);
        return {
          text: [
            `Movimiento preparado, todavía SIN registrar: ${describeMovement(pending)}.`,
            `Stock: ${pending.stockBefore} → ${pending.stockAfter}.`,
            reason ? `Motivo: ${reason}.` : 'Sin motivo.',
            `Para registrarlo hace falta la aprobación de la persona: llama a ${CONFIRM_TOOL} con el código ${code} (vence en 5 minutos). Si tu cliente no le pide la aprobación por sí mismo, pregúntale antes.`,
          ].join('\n'),
          data: { code, ...pending },
        };
      },
    }),

    defineTool({
      name: CONFIRM_TOOL,
      title: 'Confirmar un movimiento de stock',
      description:
        'Paso 2 de 2: registra en el inventario el movimiento preparado con prepare_stock_movement. Úsala solo después de que el usuario haya aprobado el resumen. El código es de un solo uso.',
      inputSchema: {
        code: z
          .string()
          .trim()
          .min(1)
          .max(16)
          .describe('Código devuelto por prepare_stock_movement'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      async handler({ code }) {
        const pending = confirmations.take(code);
        const input = {
          productId: pending.productId,
          quantity: pending.quantity,
          reason: `${pending.reason ?? TYPE_NAMES[pending.type]} ${AGENT_REASON_SUFFIX}`,
        };
        const movement =
          pending.type === 'in'
            ? await api.stockIn(input)
            : await api.stockOut(input);
        return {
          text: `Registrado: ${describeMovement(pending)}. Stock actual de ${normalizeSku(pending.sku)}: ${movement.stockAfter}.`,
          data: { movement },
        };
      },
    }),
  ];
}
