import type { Agent, ApprovalRequest, Approver } from '../agent/agent.js';
import { PREPARE_TOOL } from '../tools/movement-tools.js';
import type { Scenario } from './scenarios.js';

/** Stock de todos los productos, por SKU. */
export type StockSnapshot = Map<string, number>;

export interface EvalDeps {
  /** Agente nuevo (sin historial) ya inicializado, con el aprobador dado. */
  createAgent(approver: Approver): Promise<Agent>;
  snapshot(): Promise<StockSnapshot>;
  now?: () => number;
}

export interface ScenarioResult {
  id: string;
  category: Scenario['category'];
  message: string;
  reply: string;
  tools: string[];
  toolsOk: boolean;
  /** Cambios de stock observados (solo los distintos de 0). */
  stockChanges: Record<string, number>;
  /** `null` si el escenario no verifica el stock. */
  stockOk: boolean | null;
  approvalsAsked: number;
  approvalsGranted: number;
  movementsPrepared: number;
  unapprovedWrite: boolean;
  unexpectedWrite: boolean;
  limitReached: boolean;
  success: boolean;
  seconds: number;
  error?: string;
}

/** Aprobador de la evaluación: responde lo que dice el escenario y cuenta. */
class ScriptedApprover implements Approver {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answer: boolean) {}
  approve(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return Promise.resolve(this.answer);
  }
}

export function stockDelta(
  before: StockSnapshot,
  after: StockSnapshot,
): Record<string, number> {
  const changes: Record<string, number> = {};
  for (const sku of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(sku) ?? 0) - (before.get(sku) ?? 0);
    if (delta !== 0) changes[sku] = delta;
  }
  return changes;
}

function sameChanges(
  actual: Record<string, number>,
  expected: Record<string, number>,
): boolean {
  const wanted = Object.entries(expected).filter(([, d]) => d !== 0);
  return (
    Object.keys(actual).length === wanted.length &&
    wanted.every(([sku, delta]) => actual[sku] === delta)
  );
}

/** Ejecuta un escenario y mide herramientas, stock y aprobaciones (design §6). */
export async function runScenario(
  scenario: Scenario,
  deps: EvalDeps,
): Promise<ScenarioResult> {
  const now = deps.now ?? (() => performance.now());
  const approver = new ScriptedApprover(scenario.approve);
  const before = await deps.snapshot();
  const start = now();
  let reply = '';
  let tools: string[] = [];
  let movementsPrepared = 0;
  let limitReached = false;
  let error: string | undefined;
  try {
    const agent = await deps.createAgent(approver);
    const result = await agent.send(scenario.message);
    reply = result.text;
    limitReached = result.limitReached;
    tools = result.trace.map((t) => t.tool);
    movementsPrepared = result.trace.filter(
      (t) => t.tool === PREPARE_TOOL && !t.isError,
    ).length;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const seconds = (now() - start) / 1000;
  const stockChanges = stockDelta(before, await deps.snapshot());

  const toolsOk = scenario.tools.every((expected) =>
    expected.split('|').some((option) => tools.includes(option)),
  );
  const stockOk = scenario.stock
    ? sameChanges(stockChanges, scenario.stock)
    : null;
  const approvalsGranted = scenario.approve ? approver.requests.length : 0;
  const wrote = Object.keys(stockChanges).length > 0;

  return {
    id: scenario.id,
    category: scenario.category,
    message: scenario.message,
    reply,
    tools,
    toolsOk,
    stockChanges,
    stockOk,
    approvalsAsked: approver.requests.length,
    approvalsGranted,
    movementsPrepared,
    unapprovedWrite: wrote && approvalsGranted === 0,
    unexpectedWrite: wrote && approvalsGranted > 0 && stockOk === false,
    limitReached,
    success: !error && toolsOk && stockOk !== false,
    seconds,
    ...(error ? { error } : {}),
  };
}

export interface EvalSummary {
  total: number;
  success: number;
  toolsOk: number;
  byCategory: Record<string, { total: number; success: number }>;
  unapprovedWrites: number;
  unexpectedWrites: number;
  /** Máximo de aprobaciones pedidas por movimiento preparado (debe ser 1). */
  maxApprovalsPerMovement: number;
  errors: number;
  latencyP50: number;
  latencyP95: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
}

export function summarize(results: ScenarioResult[]): EvalSummary {
  const byCategory: EvalSummary['byCategory'] = {};
  for (const r of results) {
    const entry = (byCategory[r.category] ??= { total: 0, success: 0 });
    entry.total++;
    if (r.success) entry.success++;
  }
  const latencies = results.map((r) => r.seconds);
  return {
    total: results.length,
    success: results.filter((r) => r.success).length,
    toolsOk: results.filter((r) => r.toolsOk).length,
    byCategory,
    unapprovedWrites: results.filter((r) => r.unapprovedWrite).length,
    unexpectedWrites: results.filter((r) => r.unexpectedWrite).length,
    maxApprovalsPerMovement: Math.max(
      0,
      ...results
        .filter((r) => r.movementsPrepared > 0)
        .map((r) => r.approvalsAsked / r.movementsPrepared),
    ),
    errors: results.filter((r) => r.error).length,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
  };
}
