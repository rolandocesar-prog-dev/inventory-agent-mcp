import type { InventoryClient } from '../inventory/client.js';

export class StartupError extends Error {
  override name = 'StartupError';
}

/**
 * Comprueba la sesión antes de aceptar clientes (RF-01) y exige una cuenta de
 * operador: el servidor nunca trabaja con más permisos de los necesarios (RNF-01).
 */
export async function verifyAccount(
  client: Pick<InventoryClient, 'me'>,
): Promise<void> {
  const user = await client.me();
  if (user.role !== 'OPERATOR') {
    throw new StartupError(
      `La cuenta configurada tiene rol ${user.role}; usa una cuenta de operador (mínimo privilegio).`,
    );
  }
}
