import type { AgentTool, ToolCaller } from './mcp-connection.js';
import type { ChatMessage, ChatModel } from './ollama.js';

export const MAX_TOOL_CALLS = 6;

export const SYSTEM_PROMPT = [
  'Eres el asistente de inventario de un pequeño comercio. Responde siempre en español, breve y claro.',
  'Usa las herramientas para cualquier dato del inventario; nunca inventes productos, SKU ni cifras.',
  'Si no conoces el SKU exacto, búscalo primero con search_products.',
  'Para registrar una entrada o una salida: llama a prepare_stock_movement y luego a confirm_stock_movement con el código; el sistema le pedirá la aprobación a la persona antes de registrar.',
  'Si una herramienta devuelve un error, explícalo con tus palabras y sugiere qué hacer.',
  'Si te piden algo que tus herramientas no permiten (crear, editar o borrar productos, ajustes de inventario, usuarios, reportes de admin), di que no puedes hacerlo.',
].join('\n');

/** Pedido de aprobación de una herramienta destructiva (RF-05). */
export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  /** Resumen del movimiento preparado, si se conoce su código. */
  summary?: string;
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<boolean>;
}

export interface TraceEntry {
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** Solo en herramientas destructivas: si la persona aprobó. */
  approved?: boolean;
}

export interface AgentReply {
  text: string;
  trace: TraceEntry[];
  limitReached: boolean;
}

export const NOT_APPROVED =
  'La persona NO aprobó el movimiento: no se registró nada. Pregúntale si quiere cambiar algo.';
export const LIMIT_REACHED = `Llegué al límite de ${MAX_TOOL_CALLS} consultas para este pedido. ¿Puedes dividirlo en pedidos más simples?`;

/**
 * Agente conversacional: el modelo elige herramientas MCP, el agente las
 * ejecuta y pide aprobación humana para las destructivas (design §5).
 */
export class Agent {
  private tools: AgentTool[] = [];
  private readonly history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  /** Resumen legible de cada código de confirmación emitido. */
  private readonly prepared = new Map<string, string>();

  constructor(
    private readonly model: ChatModel,
    private readonly caller: ToolCaller,
    private readonly approver: Approver,
  ) {}

  async init(): Promise<AgentTool[]> {
    this.tools = await this.caller.listTools();
    return this.tools;
  }

  async send(userText: string): Promise<AgentReply> {
    this.history.push({ role: 'user', content: userText });
    const trace: TraceEntry[] = [];

    for (;;) {
      const reply = await this.model.chat(this.history, this.tools);
      if (reply.toolCalls.length === 0) {
        this.history.push({ role: 'assistant', content: reply.content });
        return { text: reply.content, trace, limitReached: false };
      }
      this.history.push({
        role: 'assistant',
        content: reply.content,
        tool_calls: reply.toolCalls,
      });
      for (const call of reply.toolCalls) {
        if (trace.length >= MAX_TOOL_CALLS) {
          // El historial debe cerrar cada llamada pedida con un resultado.
          this.history.push({
            role: 'tool',
            tool_name: call.function.name,
            content: 'No se ejecutó: se alcanzó el límite de llamadas.',
          });
          continue;
        }
        trace.push(
          await this.execute(call.function.name, call.function.arguments ?? {}),
        );
      }
      if (trace.length >= MAX_TOOL_CALLS) {
        this.history.push({ role: 'assistant', content: LIMIT_REACHED });
        return { text: LIMIT_REACHED, trace, limitReached: true };
      }
    }
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<TraceEntry> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      this.reply(
        name,
        `La herramienta ${name} no existe. Usa solo las disponibles.`,
      );
      return { tool: name, args, isError: true };
    }

    if (tool.destructive) {
      const code =
        typeof args['code'] === 'string'
          ? args['code'].trim().toUpperCase()
          : '';
      const summary = this.prepared.get(code);
      const approved = await this.approver.approve({
        tool: name,
        args,
        ...(summary ? { summary } : {}),
      });
      if (!approved) {
        this.reply(name, NOT_APPROVED);
        return { tool: name, args, isError: false, approved: false };
      }
      const outcome = await this.caller.callTool(name, args);
      this.reply(name, outcome.text);
      return { tool: name, args, isError: outcome.isError, approved: true };
    }

    const outcome = await this.caller.callTool(name, args);
    const code = outcome.data?.['code'];
    if (typeof code === 'string') {
      this.prepared.set(code, outcome.text.split('\n').slice(0, 3).join(' '));
    }
    this.reply(name, outcome.text);
    return { tool: name, args, isError: outcome.isError };
  }

  private reply(toolName: string, content: string): void {
    this.history.push({ role: 'tool', tool_name: toolName, content });
  }
}
