import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles TypeScript with decorator metadata, which NestJS dependency injection needs.
// Inline projects inherit these plugins and options.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.spec.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          setupFiles: ['test/setup/load-env.ts'],
          // One shared test database: run files sequentially.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
