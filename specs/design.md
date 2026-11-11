# Diseño — Agente de inventario con MCP

Responde al **cómo** de [`requirements.md`](./requirements.md).

## 1. Arquitectura

```
Usuario ──► agente de terminal ──(MCP por stdio)──► servidor MCP ──(HTTP + JWT)──► API de inventario
                 │                                       │
                 └──(HTTP)──► Ollama (qwen3.5)           └── almacén de confirmaciones (memoria)
```

- El **servidor MCP** es el único que conoce la API. Cualquier cliente MCP (el agente de este
  repo, un IDE, un asistente de escritorio) obtiene las mismas herramientas y las mismas
  protecciones.
- El **agente** no llama a la API: lanza el servidor como proceso hijo, habla MCP con él y usa
  Ollama para decidir qué herramienta llamar. Así se prueba el protocolo de punta a punta.

```
src/
├── config.ts                 # variables de entorno validadas con zod
├── inventory/                # cliente HTTP de la API (login, renovación, errores RFC 9457)
├── tools/                    # lógica de las herramientas, sin depender de MCP
│   ├── catalog-tools.ts      # buscar, detalle, stock bajo, kardex
│   ├── movement-tools.ts     # preparar y confirmar movimientos
│   └── confirmations.ts      # códigos de un solo uso con vencimiento
├── server/                   # McpServer: registra las herramientas; main.ts = stdio
├── agent/                    # cliente MCP, Ollama, bucle del agente, aprobación humana
└── eval/                     # escenarios y métricas (RF-06)
```

## 2. Tecnologías

| Necesidad      | Elección                              | Motivo                                             |
| -------------- | ------------------------------------- | -------------------------------------------------- |
| Lenguaje       | TypeScript estricto, Node.js 22, ESM  | Igual que la API de inventario; tipos compartidos. |
| Protocolo      | `@modelcontextprotocol/sdk` (oficial) | Servidor, cliente stdio y transporte en memoria.   |
| Validación     | zod                                   | Esquemas de entrada de las herramientas y del env. |
| HTTP           | `fetch` nativo                        | Sin dependencias para la API ni para Ollama.       |
| Modelo         | Ollama `/api/chat` con `tools`        | Local y gratuito; `qwen3.5:9b` por defecto.        |
| Pruebas        | Vitest                                | Rápido, ESM, el mismo de la API de inventario.     |
| Lint / formato | oxlint (con tipos) + Prettier         | Mismo estándar que el resto del portafolio.        |

**Elección del modelo** (sondeo del 2026-11-11 con 5 pedidos en español y 3 herramientas):
`qwen3.5:9b` eligió bien 5/5 (≈ 2 s por pedido con la GPU del equipo); `qwen3.5:4b`, 4/5 (ante
«Vendí 3 martillos MART-001» buscó el producto en vez de preparar la salida). Ambos se pueden usar
con `AGENT_MODEL`; la evaluación (§6) compara los dos.

## 3. Cliente de la API de inventario (RF-01, RF-04)

- `InventoryClient` hace `POST /auth/login` al primer uso y guarda los tokens en memoria. Ante un
  401 renueva con `POST /auth/refresh` y repite la petición **una vez**; si vuelve a fallar,
  inicia sesión de nuevo y, si tampoco puede, lanza `InventoryAuthError`.
- Los errores con `Content-Type: application/problem+json` se convierten en `InventoryProblem`
  (`status`, `title`, `detail`). Los fallos de red se convierten en `InventoryUnavailable`.
- Operaciones (todas permitidas al operador): `searchProducts`, `listAllProducts` (recorre las
  páginas de 100), `kardex(productId, from?, to?)`, `stockIn`, `stockOut`.
- **Producto por SKU**: la API no tiene `GET /products?sku=`; se busca con `search=<SKU>` y se
  toma la coincidencia exacta del SKU (en mayúsculas). Sin coincidencia exacta → «No existe un
  producto con el SKU X».
- **Stock bajo sin permisos de admin**: el reporte `/reports/low-stock` es solo para admin; la
  herramienta recorre el catálogo activo y filtra `stock <= minStock`, ordenando por faltante.

## 4. Herramientas (RF-02, RF-03)

| Herramienta              | Entrada                                           | Anotaciones       |
| ------------------------ | ------------------------------------------------- | ----------------- |
| `search_products`        | `query?`, `page?`                                 | `readOnlyHint`    |
| `get_product`            | `sku`                                             | `readOnlyHint`    |
| `low_stock_products`     | —                                                 | `readOnlyHint`    |
| `product_movements`      | `sku`, `from?`, `to?` (AAAA-MM-DD)                | `readOnlyHint`    |
| `prepare_stock_movement` | `type` (`in`/`out`), `sku`, `quantity`, `reason?` | `readOnlyHint`    |
| `confirm_stock_movement` | `code`                                            | `destructiveHint` |

- Cada resultado trae **texto** en español (lo que lee el modelo) y `structuredContent` con los
  datos, para clientes que los aprovechen.
- **Confirmaciones** (`ConfirmationStore`): código de 6 caracteres de un alfabeto sin ambigüedades
  (sin `0/O`, `1/I`), aleatorio con `crypto.randomInt`, guardado en memoria con el pedido
  validado y vencimiento a los 5 minutos (reloj inyectable para las pruebas). `take(code)` lo
  borra al usarlo, así que es de un solo uso aunque la API falle después.
- `prepare_stock_movement` valida contra el stock actual: una salida mayor responde error sin
  código («hay 2 y pediste 5»). El resumen incluye stock actual y resultante.
- El servidor registra los movimientos con el motivo «<motivo> (vía agente)» para que el kardex
  muestre su origen.

## 5. Agente de terminal (RF-05)

- `McpConnection` lanza `node dist/server/main.js` con `StdioClientTransport`, lista las
  herramientas y convierte su JSON Schema al formato `tools` de Ollama.
- Bucle: mensajes del sistema + historial → `POST /api/chat` (`stream: false`, `think: false`,
  temperatura 0,2). Si el modelo pide herramientas, se ejecutan en orden y sus resultados vuelven
  como mensajes `tool`; se repite hasta una respuesta de texto o hasta **6 llamadas** por
  mensaje del usuario.
- **Aprobación humana**: antes de llamar a una herramienta con `destructiveHint`, el bucle consulta
  a un `Approver`. En la terminal muestra el resumen guardado del `prepare` correspondiente y
  pregunta «¿Registrar? (s/n)». Si la respuesta no es «s», no se llama a la herramienta y el
  modelo recibe «El usuario no aprobó el movimiento». La evaluación usa un `Approver` programado.
- Prompt de sistema: asistente de inventario de un comercio, en español, que usa solo las
  herramientas, nunca inventa cifras, prepara antes de confirmar y explica los errores.

## 6. Evaluación (RF-06)

- `eval/scenarios.jsonl`: cada escenario tiene `id`, `category` (`consulta`, `movimiento`,
  `rechazo-humano`, `fuera-de-alcance`), los mensajes del usuario, si el humano aprueba y lo
  esperado: herramientas que deben usarse y cambio de stock por SKU.
- `npm run eval` corre contra la API **local** (la del `docker compose` de la API de inventario,
  con la cuenta demo) y mide, por escenario y en total:
  - **herramienta correcta**: usó las herramientas esperadas;
  - **tarea cumplida**: el stock cambió exactamente lo esperado (0 si el humano rechaza o el pedido
    está fuera de alcance);
  - **escrituras sin aprobación**: cambios de stock no aprobados (debe ser **0**);
  - latencia por escenario (p50 y p95).
- El reporte queda en `eval/reports/` (JSON y Markdown), como en el asistente RAG.

## 7. Estrategia de pruebas

| Nivel         | Qué se prueba                                                                                                            | Dónde              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Unitarias     | Cliente con `fetch` simulado, herramientas con API falsa, confirmaciones con reloj falso, bucle con Ollama y MCP falsos. | `src/**/*.spec.ts` |
| Integración   | Servidor MCP real con cliente MCP real por `InMemoryTransport`.                                                          | `test/*.spec.ts`   |
| Punta a punta | Agente → servidor → API de inventario local (manual y evaluación).                                                       | `npm run eval`     |

El CI corre unitarias e integración (no necesita Ollama ni la API). La evaluación, como en el
asistente RAG, se corre en local y su reporte se versiona.

## 8. Configuración

| Variable             | Uso                                 | Por defecto              |
| -------------------- | ----------------------------------- | ------------------------ |
| `INVENTORY_API_URL`  | Base de la API (`…/api/v1`)         | — (obligatoria)          |
| `INVENTORY_EMAIL`    | Cuenta de operador                  | — (obligatoria)          |
| `INVENTORY_PASSWORD` | Contraseña de esa cuenta            | — (obligatoria)          |
| `OLLAMA_URL`         | Servidor de Ollama (solo el agente) | `http://127.0.0.1:11434` |
| `AGENT_MODEL`        | Modelo del agente                   | `qwen3.5:9b`             |

Por stdio, `stdout` es exclusivo del protocolo MCP: el servidor escribe sus logs en `stderr`.
