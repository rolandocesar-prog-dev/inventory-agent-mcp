import { z } from 'zod';

export const CATEGORIES = [
  'consulta',
  'movimiento',
  'rechazo-humano',
  'error-de-negocio',
  'fuera-de-alcance',
] as const;

const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z]\d{2}$/),
  category: z.enum(CATEGORIES),
  message: z.string().min(3),
  /** Respuesta de la persona cuando se le pide aprobación. */
  approve: z.boolean().default(true),
  /** Herramientas que deben aparecer; `a|b` acepta cualquiera de las dos. */
  tools: z.array(z.string().min(1)),
  /** Cambio de stock esperado por SKU; sin el campo, no se verifica el stock. */
  stock: z.record(z.string(), z.number().int()).optional(),
});

export type Scenario = z.output<typeof scenarioSchema>;

/** Lee `eval/scenarios.jsonl`: un escenario por línea; ids únicos (RF-06). */
export function parseScenarios(text: string): Scenario[] {
  const scenarios = text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      const result = scenarioSchema.safeParse(JSON.parse(line));
      if (!result.success) {
        throw new Error(
          `Escenario inválido en la línea ${number}: ${result.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      return result.data;
    });
  const ids = scenarios.map((s) => s.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0) {
    throw new Error(`Escenarios repetidos: ${repeated.join(', ')}`);
  }
  return scenarios;
}
