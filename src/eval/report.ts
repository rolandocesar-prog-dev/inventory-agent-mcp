import type { EvalSummary, ScenarioResult } from './evaluate.js';

export interface EvalReport {
  date: string;
  model: string;
  summary: EvalSummary;
  results: ScenarioResult[];
}

const pct = (part: number, total: number) =>
  total === 0 ? '—' : `${Math.round((100 * part) / total)} %`;
const mark = (ok: boolean | null) => (ok === null ? '—' : ok ? '✓' : '✗');
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** Reporte en Markdown para versionar junto al JSON (como en el asistente RAG). */
export function toMarkdown(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    `# Evaluación del agente · ${report.model} · ${report.date}`,
    '',
    '| Métrica | Resultado |',
    '| --- | --- |',
    `| Tareas cumplidas | ${s.success}/${s.total} (${pct(s.success, s.total)}) |`,
    `| Herramienta correcta | ${s.toolsOk}/${s.total} (${pct(s.toolsOk, s.total)}) |`,
    `| Escrituras sin aprobación | ${s.unapprovedWrites} |`,
    `| Escrituras inesperadas | ${s.unexpectedWrites} |`,
    `| Aprobaciones por movimiento (máx.) | ${s.maxApprovalsPerMovement} |`,
    `| Errores | ${s.errors} |`,
    `| Latencia p50 / p95 | ${s.latencyP50.toFixed(1)} s / ${s.latencyP95.toFixed(1)} s |`,
    '',
    '| Categoría | Cumplidas |',
    '| --- | --- |',
    ...Object.entries(s.byCategory).map(
      ([category, c]) => `| ${category} | ${c.success}/${c.total} |`,
    ),
    '',
    '| Id | Mensaje | Herramientas | Stock | Aprob. | Tiempo | Resultado |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map((r) => {
      const stock =
        Object.entries(r.stockChanges)
          .map(([sku, d]) => `${sku} ${d > 0 ? '+' : ''}${d}`)
          .join(', ') || 'sin cambios';
      return `| ${r.id} | ${cell(r.message)} | ${r.tools.join(', ') || '—'} ${mark(r.toolsOk)} | ${stock} ${mark(r.stockOk)} | ${r.approvalsAsked} | ${r.seconds.toFixed(1)} s | ${r.success ? '✓' : `✗${r.error ? ` ${cell(r.error)}` : ''}`} |`;
    }),
    '',
    '## Respuestas',
    '',
    ...report.results.flatMap((r) => [
      `**${r.id}** · ${r.message}`,
      '',
      `> ${(r.reply || r.error || '(sin respuesta)').replace(/\n+/g, '\n> ')}`,
      '',
    ]),
  ];
  return `${lines.join('\n')}\n`;
}
