# Requisitos — Agente de inventario con MCP

> Spec Driven Development: **qué** debe hacer el sistema. El **cómo** está en
> [`design.md`](./design.md) y el plan en [`tasks.md`](./tasks.md).

## 1. Objetivo

Permitir que el personal de un pequeño comercio consulte y mueva su inventario **conversando en
español**, sin aprender la API. El sistema expone las operaciones de la
[API de inventario](https://github.com/rolandocesar-prog-dev/inventory-api-nestjs) como
herramientas del **Model Context Protocol (MCP)**, para que cualquier cliente compatible las use,
e incluye un agente de terminal que funciona con un modelo local (Ollama).

La prioridad es la **seguridad de las acciones**: el agente nunca modifica el inventario sin que
una persona confirme exactamente qué se va a registrar.

## 2. Actores

| Actor              | Descripción                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| Usuario            | Persona del comercio que conversa con el agente.                          |
| Cliente MCP        | Programa que habla MCP con el servidor (el agente de este repo u otro).   |
| API de inventario  | Servicio existente; el servidor la usa con una cuenta de **operador**.    |
| Modelo de lenguaje | Elige qué herramienta usar y redacta las respuestas (Ollama por defecto). |

## 3. Alcance

**Incluye:** servidor MCP por stdio, herramientas de consulta y de movimientos de stock con
confirmación, agente de terminal con Ollama, evaluación con escenarios y documentación para
conectarlo a otros clientes MCP.

**Fuera de alcance (v1):** crear o editar productos, ajustes de inventario, gestión de usuarios y
reportes de admin (el agente solo tiene permisos de operador), interfaz web y transporte HTTP.

## 4. Requisitos funcionales

Criterios de aceptación en formato EARS.

### RF-01 · Conexión con la API de inventario

- CUANDO el servidor arranca, DEBE iniciar sesión en la API con la cuenta configurada
  (`INVENTORY_API_URL`, `INVENTORY_EMAIL`, `INVENTORY_PASSWORD`).
- SI falta una variable o las credenciales son inválidas, el servidor NO DEBE arrancar y DEBE
  indicar qué falta, sin mostrar valores secretos.
- CUANDO el token de acceso expira, el cliente DEBE renovarlo con el token de renovación y
  repetir la petición una vez, sin intervención del usuario.
- La cuenta configurada DEBE tener rol de operador: el servidor NO DEBE ofrecer operaciones que
  ese rol no pueda hacer.

### RF-02 · Herramientas de consulta

- El servidor DEBE ofrecer herramientas para: buscar productos por nombre o SKU, ver el detalle de
  un producto por SKU, listar los productos con stock igual o menor a su mínimo y ver el historial
  de movimientos (kardex) de un producto entre dos fechas.
- Las herramientas de consulta DEBEN declararse de solo lectura (`readOnlyHint`).
- SI un SKU no existe, la herramienta DEBE responder con un error claro, no con una lista vacía.

### RF-03 · Movimientos de stock con confirmación

- Registrar una entrada o una salida DEBE hacerse en **dos pasos**:
  1. `prepare_stock_movement` valida el pedido y devuelve un resumen (producto, cantidad, stock
     actual y stock resultante) con un **código de confirmación**; no modifica nada.
  2. `confirm_stock_movement` recibe ese código y registra el movimiento.
- El código DEBE ser de un solo uso y vencer a los 5 minutos; SI se usa vencido, repetido o
  inventado, la herramienta DEBE responder con error y no registrar nada.
- SI una salida dejaría el stock en negativo, `prepare_stock_movement` DEBE avisarlo y no emitir
  código. SI el stock cambió entre ambos pasos, el error de la API (422) DEBE informarse.
- `confirm_stock_movement` DEBE declararse destructiva (`destructiveHint`) para que los clientes
  MCP pidan aprobación.

### RF-04 · Errores

- CUANDO la API responde con un error RFC 9457, la herramienta DEBE devolver un resultado de error
  (`isError`) con el `detail` en español, para que el modelo lo explique al usuario.
- SI la API no responde, la herramienta DEBE devolver un error que diga que el servicio no está
  disponible, sin trazas internas.

### RF-05 · Agente de terminal

- El agente DEBE conectarse al servidor por MCP (stdio), listar sus herramientas y conversar en
  español con un modelo de Ollama configurable.
- ANTES de ejecutar `confirm_stock_movement`, el agente DEBE mostrar el resumen al usuario y pedir
  su aprobación explícita (`s`/`n`). SI el usuario no aprueba, NO DEBE llamar a la herramienta.
- La decisión de registrar DEBE depender solo de la aprobación de la persona, no del modelo, y la
  persona NO DEBE tener que aprobar dos veces el mismo movimiento.
- El agente DEBE limitar a 6 las llamadas a herramientas por mensaje del usuario y avisar si llega
  al límite.
- SI el pedido no se puede hacer con las herramientas disponibles (p. ej. borrar un producto), el
  agente DEBE decirlo en lugar de inventar un resultado.

### RF-06 · Evaluación

- El repositorio DEBE incluir un conjunto de escenarios en español y un comando que los ejecute
  contra la API de inventario local y mida: herramienta correcta, tarea cumplida, escrituras sin
  confirmación (debe ser 0) y pedidos fuera de alcance rechazados.

## 5. Requisitos no funcionales

| ID     | Requisito                                                                        |
| ------ | -------------------------------------------------------------------------------- |
| RNF-01 | Mínimo privilegio: cuenta de operador; ningún secreto en el repositorio ni logs. |
| RNF-02 | Por stdio, la salida estándar es solo del protocolo; los logs van a stderr.      |
| RNF-03 | TypeScript estricto, lint, formato y pruebas en CI; cobertura ≥ 80 %.            |
| RNF-04 | Funciona con cualquier cliente MCP; el README muestra cómo configurarlo.         |
| RNF-05 | Sin costo: modelo local con Ollama; la API puede ser la local o la publicada.    |

## 6. Criterio de "terminado"

- Todos los RF con pruebas automatizadas; la evaluación corrida y documentada.
- README con demo, diagrama, configuración de clientes MCP y resultados.
- Proyecto agregado a la sección Proyectos del CV (web y PDF).
