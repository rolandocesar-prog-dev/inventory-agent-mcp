# Tareas — Agente de inventario con MCP

Cada tarea referencia su requisito. Marca `[x]` al terminar y haz un commit por tarea.

## M0 · Base del proyecto

- [x] Especificaciones SDD.
- [x] Proyecto TypeScript estricto (ESM, Node 22) con Vitest, oxlint, Prettier y CI.

## M1 · Cliente de la API de inventario (RF-01, RF-04)

- [x] Configuración validada con zod (sin mostrar secretos).
- [x] `InventoryClient`: login, renovación ante 401 y errores RFC 9457 / red.
- [x] Operaciones: búsqueda, catálogo completo, kardex, entradas y salidas.

## M2 · Servidor MCP (RF-02, RF-03, RNF-02)

- [x] Herramientas de consulta: buscar, detalle por SKU, stock bajo y kardex.
- [x] Confirmaciones de un solo uso con vencimiento.
- [x] `prepare_stock_movement` y `confirm_stock_movement`.
- [x] Servidor MCP por stdio con anotaciones; prueba de integración con un cliente MCP real.

## M3 · Agente de terminal (RF-05)

- [x] Conexión MCP por stdio y conversión de herramientas al formato de Ollama.
- [ ] Bucle del agente con límite de 6 llamadas y aprobación humana de las escrituras.
- [ ] CLI interactiva `inventory-agent`, probada contra la API local.

## M4 · Evaluación (RF-06)

- [ ] Escenarios en español (consulta, movimiento, rechazo humano, fuera de alcance).
- [ ] `npm run eval` con métricas y reporte; comparar `qwen3.5:9b` y `qwen3.5:4b`.

## M5 · Entrega

- [ ] README con demo, diagrama, configuración de clientes MCP y resultados.
- [ ] Repositorio público en GitHub con CI en verde.
- [ ] Agregar el proyecto a la sección Proyectos del CV (web y PDF).
