# Agente de inventario con MCP — TypeScript, Ollama y Model Context Protocol

[![CI](https://github.com/rolandocesar-prog-dev/inventory-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rolandocesar-prog-dev/inventory-agent-mcp/actions/workflows/ci.yml)

Consulta y mueve el inventario de un comercio **conversando en español**. Un servidor **MCP**
expone la [API de inventario](https://github.com/rolandocesar-prog-dev/inventory-api-nestjs)
como herramientas que cualquier cliente compatible puede usar, y un agente de terminal las usa
con un modelo **local y gratuito** (Ollama). La prioridad es la seguridad: **ningún movimiento se
registra sin que una persona apruebe el resumen exacto** que devuelve el servidor.

![Demo: consulta, entrada aprobada, venta sin stock, venta rechazada y pedido fuera de alcance](docs/demo.gif)

> La demo es una conversación real con `qwen3.5:9b` contra la API de inventario local; el texto
> es la salida de la terminal sin editar (solo se quitaron los `**` de Markdown).

## Qué demuestra

- **Model Context Protocol de punta a punta**: servidor MCP por stdio con 6 herramientas,
  anotaciones (`readOnlyHint`, `destructiveHint`) y un agente que es un cliente MCP real: lanza el
  servidor, lista sus herramientas y las ofrece al modelo.
- **Acciones seguras con un LLM**: los movimientos van en dos pasos (preparar → confirmar) con un
  código de un solo uso que vence en 5 minutos. **La aprobación la pide el sistema, no el modelo**,
  y una sola vez; si el modelo intenta confirmar por su cuenta, también pasa por la persona.
- **Mínimo privilegio**: el servidor se niega a arrancar con una cuenta que no sea de operador.
  Los ajustes y los reportes de admin no existen para el agente.
- **Evaluación con escenarios**, como en el [asistente RAG](https://github.com/rolandocesar-prog-dev/docs-rag-assistant):
  18 pedidos en español que miden herramienta correcta, tarea cumplida y, sobre todo,
  **escrituras sin aprobación (0)** y **escrituras inesperadas (0)**, comparando dos modelos.
- **Calidad**: TypeScript estricto, 126 pruebas (unitarias e integración con servidor y cliente
  MCP reales en memoria), cobertura ≈ 99 % con umbral de 80 % en el CI.

## Arquitectura

```mermaid
flowchart LR
    U[Persona] <--> A
    subgraph agente[Agente de terminal]
        A[CLI + bucle del agente<br/>aprobación humana] --> M[Ollama<br/>qwen3.5]
        A -->|cliente MCP| T
    end
    subgraph servidor[Servidor MCP · stdio]
        T[6 herramientas<br/>zod + anotaciones] --> C[Confirmaciones<br/>un solo uso · 5 min]
        T --> I[Cliente HTTP<br/>login · renovación · RFC 9457]
    end
    I -->|JWT de operador| API[(API de inventario<br/>NestJS + PostgreSQL)]
    O[Otro cliente MCP] -.->|mismas herramientas| T
```

```mermaid
sequenceDiagram
    participant P as Persona
    participant A as Agente
    participant L as Modelo (Ollama)
    participant S as Servidor MCP
    P->>A: «Vendí 2 rodillos ROD-009»
    A->>L: mensaje + herramientas
    L-->>A: prepare_stock_movement(out, ROD-009, 2)
    A->>S: prepare_stock_movement
    S-->>A: resumen «Salida de 2 × ROD-009 · stock 18 → 16» + código
    A->>P: ¿Registrar? (s/n)
    P-->>A: s
    A->>S: confirm_stock_movement(código)
    S-->>A: registrado, stock 16
    A->>L: RESULTADO: aprobado y registrado
    L-->>A: «Listo, quedan 16»
    A->>P: respuesta
```

## Herramientas MCP

| Herramienta              | Qué hace                                                                  | Anotación    |
| ------------------------ | ------------------------------------------------------------------------- | ------------ |
| `search_products`        | Busca por nombre o SKU (stock, mínimo, precio).                           | solo lectura |
| `get_product`            | Detalle de un producto por SKU exacto.                                    | solo lectura |
| `low_stock_products`     | Productos en su stock mínimo o por debajo, los más urgentes primero.      | solo lectura |
| `product_movements`      | Kardex de un producto entre dos fechas.                                   | solo lectura |
| `prepare_stock_movement` | Valida una entrada o salida y devuelve resumen y código; **no registra**. | solo lectura |
| `confirm_stock_movement` | Registra el movimiento preparado (código de un solo uso).                 | destructiva  |

Los errores de la API (p. ej. «Stock insuficiente: hay 1 y se pidieron 5») llegan al modelo como
`isError` con el detalle en español, para que los explique.

## Resultados de la evaluación

`npm run eval` corre los 18 escenarios contra la API local (reportes en
[`eval/reports/`](./eval/reports)).

| Modelo       | Cumplidas | Herramienta correcta | Sin aprobación | Inesperadas | Aprob. por movimiento | p50   |
| ------------ | --------- | -------------------- | -------------- | ----------- | --------------------- | ----- |
| `qwen3.5:9b` | 17/18     | 17/18                | **0**          | **0**       | 1                     | 2,7 s |
| `qwen3.5:4b` | 17/18     | 17/18                | **0**          | **0**       | 1                     | 1,7 s |

Lo que encontró la evaluación (y qué se hizo):

- **Ajuste simulado**: ante «hice un conteo, ajusta el cable a 10», el modelo de 4B registró una
  entrada de 7 y dijo «ajuste registrado». Se agregó una regla al prompt y la escritura no volvió a
  ocurrir; aun así los modelos todavía _ofrecen_ esa vía en el texto. La protección que no depende
  del modelo es que la persona aprueba el resumen del servidor, que dice «Entrada de 7».
- **Doble confirmación**: con la aprobación solo antes de confirmar, el modelo además preguntaba en
  el chat. Ahora el sistema pregunta al preparar, una vez, y el mensaje al modelo empieza por el
  resultado («RESULTADO: la persona RECHAZÓ…»).
- **«Hoy»**: sin la fecha en el prompt, el modelo inventaba fechas; ahora la recibe.
- **«Registra la venta de un martillo»** sigue fallando: los modelos preguntan la cantidad. No se
  cambió el escenario para no acomodar la prueba al modelo.

## Cómo usarlo

Requisitos: Node.js 22, [Ollama](https://ollama.com) con `qwen3.5:9b` (o `qwen3.5:4b`) y la API
de inventario (la local con `docker compose up` o la
[publicada](https://inventory-api-c5yi.onrender.com/docs)).

```bash
npm ci
cp .env.example .env        # URL de la API y la cuenta demo de operador
ollama pull qwen3.5:9b
npm run build
node dist/agent/main.js     # agente de terminal
```

### Con otro cliente MCP

El servidor es un comando por stdio; cualquier cliente MCP lo puede lanzar. Configuración típica
(`mcpServers` de un cliente de escritorio o de un IDE):

```json
{
  "mcpServers": {
    "inventario": {
      "command": "node",
      "args": ["/ruta/a/inventory-agent-mcp/dist/server/main.js"],
      "env": {
        "INVENTORY_API_URL": "https://inventory-api-c5yi.onrender.com/api/v1",
        "INVENTORY_EMAIL": "demo@inventario.test",
        "INVENTORY_PASSWORD": "demo-inventario-2026"
      }
    }
  }
}
```

La cuenta `demo@inventario.test` es la cuenta pública de demostración (rol operador) de la API.

## Calidad

```bash
npm run lint          # oxlint con información de tipos
npm run format:check  # Prettier
npm run typecheck     # tsc estricto
npm run test:cov      # unitarias + integración MCP en memoria, umbral de cobertura 80 %
npm run eval          # escenarios contra la API local y Ollama (en local)
```

El CI corre todo menos la evaluación, que necesita Ollama y la API (como en el asistente RAG,
su reporte se versiona).

## Decisiones y aprendizajes

- **El servidor no confía en el cliente.** La confirmación en dos pasos vive en el servidor, así
  que protege también a clientes MCP que no piden aprobación; `destructiveHint` ayuda a los que sí.
- **El modelo no decide registrar.** Probar con modelos reales mostró que un modelo chico no sigue
  al pie de la letra «no preguntes en el chat» ni «no ofrezcas ajustes». Por eso la aprobación la
  controla el código del agente y el texto que aprueba la persona sale del servidor, no del modelo.
- **Medir antes de afirmar.** Cada ajuste de prompt se midió con los mismos 18 escenarios y dos
  modelos; los reportes anteriores y posteriores quedan en el repositorio.
- **Pequeños detalles que importan**: el token de renovación de la API es de un solo uso, así que
  varios 401 simultáneos comparten una sola renovación; por stdio, `stdout` es solo del protocolo y
  los logs van a `stderr`.

## Cómo se desarrolla

Spec Driven Development: [`specs/requirements.md`](./specs/requirements.md) (requisitos EARS),
[`specs/design.md`](./specs/design.md) (diseño, decisiones y resultados) y
[`specs/tasks.md`](./specs/tasks.md) (plan por hitos, un commit por tarea).

## Licencia

[MIT](./LICENSE)
