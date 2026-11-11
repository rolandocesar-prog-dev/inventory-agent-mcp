import type { AgentTool } from './mcp-connection.js';

/** Mensaje del chat de Ollama (`/api/chat`). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  /** En mensajes `tool`: qué herramienta produjo el resultado. */
  tool_name?: string;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
}

/** Modelo de lenguaje con herramientas (Ollama en producción, falso en pruebas). */
export interface ChatModel {
  chat(messages: ChatMessage[], tools: AgentTool[]): Promise<ChatReply>;
}

export class ModelError extends Error {
  override name = 'ModelError';
}

export const CHAT_TIMEOUT_MS = 120_000;

/** Formato `tools` de Ollama a partir de las herramientas MCP. */
export function toOllamaTools(tools: AgentTool[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export class OllamaChat implements ChatModel {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[], tools: AgentTool[]): Promise<ChatReply> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: toOllamaTools(tools),
          stream: false,
          // Sin «pensamiento» visible: respuestas cortas y más rápidas.
          think: false,
          options: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch {
      throw new ModelError(
        `No se pudo conectar con Ollama en ${this.baseUrl}. ¿Está abierto?`,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ModelError(
        response.status === 404
          ? `Ollama no tiene el modelo ${this.model}. Descárgalo con: ollama pull ${this.model}`
          : `Ollama respondió ${response.status}: ${detail.slice(0, 200)}`,
      );
    }
    const body = (await response.json()) as {
      message?: { content?: string; tool_calls?: ToolCall[] };
    };
    return {
      content: body.message?.content?.trim() ?? '',
      toolCalls: body.message?.tool_calls ?? [],
    };
  }
}
