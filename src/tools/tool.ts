import { z } from 'zod';
import {
  InventoryAuthError,
  InventoryProblem,
  InventoryUnavailable,
} from '../inventory/errors.js';

/** Resultado de una herramienta: texto para el modelo y datos para el cliente. */
export interface ToolResult {
  text: string;
  data?: Record<string, unknown>;
  isError?: boolean;
}

/** Anotaciones de MCP: indican a los clientes qué herramientas modifican datos. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Herramienta lista para registrar en cualquier servidor (MCP u otro). */
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Valida la entrada, ejecuta y convierte los errores en `isError`. */
  run(args: unknown): Promise<ToolResult>;
}

/** Error esperado de una herramienta (p. ej. SKU inexistente): se muestra tal cual. */
export class ToolError extends Error {
  override name = 'ToolError';
}

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  handler(args: z.output<z.ZodObject<Shape>>): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(
  spec: ToolSpec<Shape>,
): Tool {
  const schema = z.object(spec.inputSchema);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    async run(args: unknown): Promise<ToolResult> {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          text: `Datos inválidos: ${parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join('.') || 'entrada'}: ${issue.message}`,
            )
            .join('; ')}`,
        };
      }
      try {
        return await spec.handler(parsed.data);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  };
}

/** RF-04: errores de la API con su `detail`, sin trazas internas. */
export function toErrorResult(error: unknown): ToolResult {
  if (error instanceof ToolError || error instanceof InventoryUnavailable) {
    return { isError: true, text: error.message };
  }
  if (error instanceof InventoryProblem) {
    return {
      isError: true,
      text: `La API de inventario rechazó la operación: ${error.detail}`,
      data: { status: error.status, title: error.title },
    };
  }
  if (error instanceof InventoryAuthError) {
    return {
      isError: true,
      text: 'No hay sesión válida con la API de inventario; revisa la cuenta configurada.',
    };
  }
  console.error('[inventory-mcp] error inesperado en una herramienta:', error);
  return {
    isError: true,
    text: 'Ocurrió un error inesperado en la herramienta.',
  };
}
