import { z } from 'zod';

const inventorySchema = z.object({
  INVENTORY_API_URL: z
    .url({ protocol: /^https?$/ })
    .transform((url) => url.replace(/\/+$/, '')),
  INVENTORY_EMAIL: z.email(),
  INVENTORY_PASSWORD: z.string().min(1),
});

const agentSchema = z.object({
  OLLAMA_URL: z
    .url({ protocol: /^https?$/ })
    .default('http://127.0.0.1:11434')
    .transform((url) => url.replace(/\/+$/, '')),
  AGENT_MODEL: z.string().min(1).default('qwen3.5:9b'),
});

export interface InventoryConfig {
  apiUrl: string;
  email: string;
  password: string;
}

export interface AgentConfig {
  ollamaUrl: string;
  model: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Valida el entorno. El error nombra las variables inválidas, nunca sus valores
 * (la contraseña es un secreto; RF-01, RNF-01).
 */
function parse<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv,
): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new ConfigError(
      `Variables de entorno inválidas o faltantes: ${names.join(', ')}. Revisa .env.example.`,
    );
  }
  return result.data;
}

export function loadInventoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): InventoryConfig {
  const data = parse(inventorySchema, env);
  return {
    apiUrl: data.INVENTORY_API_URL,
    email: data.INVENTORY_EMAIL,
    password: data.INVENTORY_PASSWORD,
  };
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const data = parse(agentSchema, env);
  return { ollamaUrl: data.OLLAMA_URL, model: data.AGENT_MODEL };
}
