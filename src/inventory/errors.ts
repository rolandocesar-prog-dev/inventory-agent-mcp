/** Error de la API en formato RFC 9457 (problem details). */
export class InventoryProblem extends Error {
  override name = 'InventoryProblem';

  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** La API no respondió (red caída, tiempo agotado). */
export class InventoryUnavailable extends Error {
  override name = 'InventoryUnavailable';

  constructor() {
    super('La API de inventario no está disponible en este momento.');
  }
}

/** La cuenta configurada no puede iniciar sesión o perdió la sesión. */
export class InventoryAuthError extends Error {
  override name = 'InventoryAuthError';
}
