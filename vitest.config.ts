import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      // Puntos de entrada de procesos: se prueban de punta a punta (agente y evaluación).
      exclude: ['src/**/*.spec.ts', 'src/**/main.ts'],
      // RNF-03
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
