import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The dashboard is a client-rendered SPA: it reads the service through the same
 * HTTP reporting endpoints any other consumer would, so there is no server-side
 * rendering layer between it and the read ports.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Type-only escape hatch into the service package, used by the contract
      // conformance checks. Nothing is imported from here at runtime — the
      // aliases exist so the IDE resolves what `tsc` already resolves.
      '@osa/domain': fileURLToPath(new URL('../src/domain', import.meta.url)),
      '@osa/ports': fileURLToPath(new URL('../src/ports', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
});
