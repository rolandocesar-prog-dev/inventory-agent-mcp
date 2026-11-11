#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { loadAgentConfig, loadInventoryConfig } from '../config.js';
import { Agent } from './agent.js';
import { isExit, LineQueue, terminalApprover, traceLine } from './cli.js';
import { McpConnection, serverTransport } from './mcp-connection.js';
import { OllamaChat } from './ollama.js';

try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables del entorno.
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Con una terminal, readline ya muestra lo que se escribe; con un guion, se repite.
const input = new LineQueue((text) => stdout.write(text), !stdin.isTTY);
const rl = createInterface({ input: stdin, terminal: stdin.isTTY });
rl.on('line', (line) => input.push(line));
rl.on('close', () => input.close());

let connection: McpConnection | undefined;
try {
  const config = loadAgentConfig();
  loadInventoryConfig(); // El servidor la usa; se valida aquí para un error claro.
  connection = await McpConnection.connect(serverTransport());
  const agent = new Agent(
    new OllamaChat(config.ollamaUrl, config.model),
    connection,
    terminalApprover(input),
  );
  agent.onTrace = (entry) => stdout.write(`${traceLine(entry)}\n`);
  const tools = await agent.init();
  stdout.write(
    `Agente de inventario · modelo ${config.model} · ${tools.length} herramientas por MCP.\nEscribe tu pedido o «salir».\n`,
  );

  for (;;) {
    const text = await input.question('\n> ');
    if (text === null || isExit(text)) break;
    if (!text.trim()) continue;
    try {
      const reply = await agent.send(text);
      stdout.write(`\n${reply.text}\n`);
    } catch (error) {
      stdout.write(`\n✖ ${message(error)}\n`);
    }
  }
} catch (error) {
  console.error(`No se pudo iniciar el agente: ${message(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await connection?.close();
}
