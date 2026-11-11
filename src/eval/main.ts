#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from '../agent/agent.js';
import { McpConnection, serverTransport } from '../agent/mcp-connection.js';
import { OllamaChat } from '../agent/ollama.js';
import { loadAgentConfig, loadInventoryConfig } from '../config.js';
import { InventoryClient } from '../inventory/client.js';
import { runScenario, summarize, type ScenarioResult } from './evaluate.js';
import { toMarkdown, type EvalReport } from './report.js';
import { parseScenarios } from './scenarios.js';

// Uso: npm run eval -- [--modelo qwen3.5:4b] [--escenarios ruta] [--salida carpeta]
try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables del entorno.
}

const { values } = parseArgs({
  options: {
    modelo: { type: 'string' },
    escenarios: { type: 'string', default: 'eval/scenarios.jsonl' },
    salida: { type: 'string', default: 'eval/reports' },
  },
});

const agentConfig = loadAgentConfig();
const model = values.modelo ?? agentConfig.model;
const scenarios = parseScenarios(readFileSync(values.escenarios, 'utf8'));
const inventory = new InventoryClient(loadInventoryConfig());
const connection = await McpConnection.connect(serverTransport());
const chat = new OllamaChat(agentConfig.ollamaUrl, model);

const results: ScenarioResult[] = [];
try {
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, {
      createAgent: async (approver) => {
        const agent = new Agent(chat, connection, approver);
        await agent.init();
        return agent;
      },
      snapshot: async () =>
        new Map(
          (await inventory.listAllProducts()).map((p) => [p.sku, p.stock]),
        ),
    });
    results.push(result);
    console.log(
      `${result.success ? '✓' : '✗'} ${result.id} ${result.category.padEnd(17)} ${result.seconds.toFixed(1).padStart(5)} s  ${result.tools.join(', ') || '—'}${result.error ? `  (${result.error})` : ''}`,
    );
  }
} finally {
  await connection.close();
}

const now = new Date();
const stamp = `${now.toLocaleDateString('en-CA')}-${now.toTimeString().slice(0, 8).replaceAll(':', '')}`;
const report: EvalReport = {
  date: stamp,
  model,
  summary: summarize(results),
  results,
};
mkdirSync(values.salida, { recursive: true });
const base = join(
  values.salida,
  `${stamp}-${model.replace(/[^a-z0-9.]+/gi, '-')}`,
);
writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${base}.md`, toMarkdown(report));

const s = report.summary;
console.log(
  `\nCumplidas ${s.success}/${s.total} · herramienta correcta ${s.toolsOk}/${s.total} · escrituras sin aprobación ${s.unapprovedWrites} · inesperadas ${s.unexpectedWrites} · aprobaciones por movimiento ${s.maxApprovalsPerMovement} · p50 ${s.latencyP50.toFixed(1)} s`,
);
console.log(`Reporte: ${base}.md`);
