import { randomInt } from 'node:crypto';
import { ToolError } from './tool.js';

/** Sin 0/O ni 1/I: el usuario puede dictar o copiar el código sin confundirse. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
/** Tope de pedidos pendientes en memoria; se descartan los más antiguos. */
export const MAX_PENDING = 100;

export interface PendingMovement {
  type: 'in' | 'out';
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  reason?: string;
  stockBefore: number;
  stockAfter: number;
}

interface Entry {
  movement: PendingMovement;
  expiresAt: number;
}

/**
 * Pedidos de movimiento ya validados, a la espera de confirmación (RF-03).
 * `take` borra el código al usarlo: es de un solo uso aunque la API falle.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (max: number) => number = randomInt,
  ) {}

  issue(movement: PendingMovement): string {
    this.purge();
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    let code: string;
    do {
      code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_ALPHABET[this.random(CODE_ALPHABET.length)],
      ).join('');
    } while (this.pending.has(code));
    this.pending.set(code, {
      movement,
      expiresAt: this.now() + CONFIRMATION_TTL_MS,
    });
    return code;
  }

  take(rawCode: string): PendingMovement {
    const code = rawCode.trim().toUpperCase();
    const entry = this.pending.get(code);
    this.pending.delete(code);
    if (!entry) {
      throw new ToolError(
        `El código ${code} no existe o ya se usó. Prepara el movimiento otra vez con prepare_stock_movement.`,
      );
    }
    if (entry.expiresAt <= this.now()) {
      throw new ToolError(
        `El código ${code} venció (dura 5 minutos). Prepara el movimiento otra vez con prepare_stock_movement.`,
      );
    }
    return entry.movement;
  }

  /** Pedido pendiente sin consumirlo (para mostrar el resumen antes de aprobar). */
  peek(rawCode: string): PendingMovement | undefined {
    const entry = this.pending.get(rawCode.trim().toUpperCase());
    return entry && entry.expiresAt > this.now() ? entry.movement : undefined;
  }

  get size(): number {
    return this.pending.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [code, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(code);
    }
  }
}
