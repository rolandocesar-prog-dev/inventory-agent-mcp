import { describe, expect, it } from 'vitest';
import { ConfigError, loadAgentConfig, loadInventoryConfig } from './config.js';

describe('loadInventoryConfig', () => {
  const valid = {
    INVENTORY_API_URL: 'https://inventario.example.com/api/v1/',
    INVENTORY_EMAIL: 'demo@inventario.test',
    INVENTORY_PASSWORD: 'demo-inventario-2026',
  };

  it('devuelve la configuración sin la barra final de la URL', () => {
    expect(loadInventoryConfig(valid)).toEqual({
      apiUrl: 'https://inventario.example.com/api/v1',
      email: 'demo@inventario.test',
      password: 'demo-inventario-2026',
    });
  });

  it('nombra las variables inválidas sin mostrar sus valores', () => {
    const run = () =>
      loadInventoryConfig({
        INVENTORY_API_URL: 'ftp://servidor',
        INVENTORY_EMAIL: 'no-es-correo',
        INVENTORY_PASSWORD: '',
      });

    expect(run).toThrow(ConfigError);
    expect(run).toThrow(
      /INVENTORY_API_URL, INVENTORY_EMAIL, INVENTORY_PASSWORD/,
    );
    expect(run).not.toThrow(/no-es-correo|ftp:/);
  });

  it('falla si faltan variables', () => {
    expect(() => loadInventoryConfig({})).toThrow(/INVENTORY_API_URL/);
  });
});

describe('loadAgentConfig', () => {
  it('usa Ollama local y qwen3.5:9b por defecto', () => {
    expect(loadAgentConfig({})).toEqual({
      ollamaUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
    });
  });

  it('acepta otro servidor y modelo', () => {
    expect(
      loadAgentConfig({
        OLLAMA_URL: 'http://gpu:11434/',
        AGENT_MODEL: 'qwen3.5:4b',
      }),
    ).toEqual({ ollamaUrl: 'http://gpu:11434', model: 'qwen3.5:4b' });
  });
});
