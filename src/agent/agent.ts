import { CONFIRM_TOOL } from '../tools/movement-tools.js';
import type { AgentTool, ToolCaller } from './mcp-connection.js';
import type { ChatMessage, ChatModel } from './ollama.js';

export const MAX_TOOL_CALLS = 6;

export const SYSTEM_PROMPT = [
  'Eres el asistente de inventario de un pequeño comercio. Responde siempre en español, breve y claro.',
  'Usa las herramientas para cualquier dato del inventario; nunca inventes productos, SKU ni cifras.',
  'Si no conoces el SKU exacto, búscalo primero con search_products.',
  'Para registrar una entrada o una salida: llama a prepare_stock_movement y, en cuanto tengas el código, llama a confirm_stock_movement en el mismo turno. No pidas confirmación en el chat: este sistema le muestra el resumen a la persona y le pide la aprobación antes de registrar.',
  'Si una herramienta devuelve un error, explícalo con tus palabras y sugiere qué hacer.',
  'Si te piden algo que tus herramientas no permiten (crear, editar o borrar productos, ajustes de inventario, usuarios, reportes de admin), di que no puedes hacerlo.',
  'Un conteo físico o un ajuste de stock lo hace un administrador: nunca lo simules con entradas o salidas, ni lo ofrezcas.',
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

/** Fecha local del equipo en AAAA-MM-DD. */
export function localDate(date: Date): string {
  return date.toLocaleDateString('en-CA');
}

export const NOT_APPROVED =
  'La persona NO aprobó el movimiento: no se registró nada. Pregúntale si quiere cambiar algo.';
export const ALREADY_RESOLVED =
  'Ese movimiento ya se resolvió con la persona (registrado o rechazado); no hace falta confirmarlo.';
export const LIMIT_REACHED = `Llegué al límite de ${MAX_TOOL_CALLS} consultas para este pedido. ¿Puedes dividirlo en pedidos más simples?`;

/**
 * Agente conversacional: el modelo elige herramientas MCP, el agente las
 * ejecuta y pide aprobación humana para las destructivas (design §5).
 */
export class Agent {
  private tools: AgentTool[] = [];
  private readonly history: ChatMessage[];
  /** Códigos cuya aprobación ya se resolvió (aprobados o rechazados). */
  private readonly resolved = new Set<string>();

  constructor(
    private readonly model: ChatModel,
    private readonly caller: ToolCaller,
    private readonly approver: Approver,
    /** Fecha de hoy (AAAA-MM-DD) para resolver «hoy» o «esta semana». */
    today: string = localDate(new Date()),
  ) {
    this.history = [
      { role: 'system', content: `${SYSTEM_PROMPT}\nFecha de hoy: ${today}.` },
    ];
  }

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
          ...(await this.execute(
            call.function.name,
            call.function.arguments ?? {},
          )),
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
  ): Promise<TraceEntry[]> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      this.reply(
        name,
        `La herramienta ${name} no existe. Usa solo las disponibles.`,
      );
      return [{ tool: name, args, isError: true }];
    }
    if (tool.destructive) return [await this.destructiveByModel(name, args)];

    const outcome = await this.caller.callTool(name, args);
    const entry: TraceEntry = { tool: name, args, isError: outcome.isError };
    const code = outcome.data?.['code'];
    const confirmTool = this.tools.find(
      (t) => t.destructive && t.name === CONFIRM_TOOL,
    );
    if (typeof code !== 'string' || outcome.isError || !confirmTool) {
      this.reply(name, outcome.text);
      return [entry];
    }

    // La aprobación la pide el sistema al preparar, una sola vez (design §5).
    const summary = outcome.text.split('\n').slice(0, 3).join(' ');
    this.resolved.add(code);
    const confirmArgs = { code };
    const approved = await this.approver.approve({
      tool: confirmTool.name,
      args: confirmArgs,
      summary,
    });
    if (!approved) {
      this.reply(name, `${summary}\n${NOT_APPROVED}`);
      return [
        entry,
        {
          tool: confirmTool.name,
          args: confirmArgs,
          isError: false,
          approved: false,
        },
      ];
    }
    const confirmed = await this.caller.callTool(confirmTool.name, confirmArgs);
    this.reply(
      name,
      confirmed.isError
        ? `${summary}\nLa persona aprobó, pero no se pudo registrar: ${confirmed.text}`
        : `${summary}\nLa persona aprobó y quedó registrado. ${confirmed.text} No vuelvas a confirmar este movimiento.`,
    );
    return [
      entry,
      {
        tool: confirmTool.name,
        args: confirmArgs,
        isError: confirmed.isError,
        approved: true,
      },
    ];
  }

  /** El modelo llamó por su cuenta a una herramienta destructiva: también se aprueba. */
  private async destructiveByModel(
    name: string,
    args: Record<string, unknown>,
  ): Promise<TraceEntry> {
    const code =
      typeof args['code'] === 'string' ? args['code'].trim().toUpperCase() : '';
    if (this.resolved.has(code)) {
      this.reply(name, ALREADY_RESOLVED);
      return { tool: name, args, isError: false };
    }
    const approved = await this.approver.approve({ tool: name, args });
    if (!approved) {
      this.reply(name, NOT_APPROVED);
      return { tool: name, args, isError: false, approved: false };
    }
    const outcome = await this.caller.callTool(name, args);
    this.reply(name, outcome.text);
    return { tool: name, args, isError: outcome.isError, approved: true };
  }
  private reply(toolName: string, content: string): void {
    this.history.push({ role: 'tool', tool_name: toolName, content });
  }
}
