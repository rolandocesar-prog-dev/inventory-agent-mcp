import type { Approver, TraceEntry } from './agent.js';

/** Respuestas que cuentan como aprobación: «s», «si», «sí» (sin distinguir mayúsculas). */
export function isYes(answer: string): boolean {
  return /^s[ií]?$/i.test(answer.trim());
}

/** Pregunta y espera una línea; `null` cuando la entrada terminó. */
export interface Prompter {
  question(prompt: string): Promise<string | null>;
}

/**
 * Cola de líneas de la entrada: no pierde las que llegan antes de preguntar,
 * así la CLI funciona igual escribiendo a mano que con un guion redirigido.
 * Con `echo`, repite cada línea leída (útil cuando la entrada no es una terminal).
 */
export class LineQueue implements Prompter {
  private readonly lines: string[] = [];
  private readonly waiting: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(
    private readonly write: (text: string) => void,
    private readonly echo = false,
  ) {}

  push(line: string): void {
    const resolve = this.waiting.shift();
    if (resolve) resolve(this.echoed(line));
    else this.lines.push(line);
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) resolve(null);
  }

  question(prompt: string): Promise<string | null> {
    this.write(prompt);
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(this.echoed(line));
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private echoed(line: string): string {
    if (this.echo) this.write(`${line}\n`);
    return line;
  }
}

/** Aprobación por terminal: muestra el resumen del movimiento y pregunta (RF-05). */
export function terminalApprover(prompter: Prompter): Approver {
  return {
    async approve({ summary, args }) {
      const code = typeof args['code'] === 'string' ? args['code'] : '?';
      const what = summary ?? `Movimiento con código ${code} (sin resumen)`;
      const answer = await prompter.question(
        `\n⚠ ${what}\n¿Registrar? (s/n) > `,
      );
      return answer !== null && isYes(answer);
    },
  };
}

/** «  · prepare_stock_movement {"sku":"MART-001"} (no aprobado)» */
export function traceLine(entry: TraceEntry): string {
  const notes = [
    entry.isError ? 'error' : '',
    entry.approved === false ? 'no aprobado' : '',
    entry.approved === true ? 'aprobado' : '',
  ].filter(Boolean);
  const suffix = notes.length ? ` (${notes.join(', ')})` : '';
  return `  · ${entry.tool} ${JSON.stringify(entry.args)}${suffix}`;
}

export function isExit(text: string): boolean {
  return /^(salir|exit|quit)$/i.test(text.trim());
}
