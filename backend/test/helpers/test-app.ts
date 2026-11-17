import { Writable } from 'node:stream';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import type { AppConfig } from '../../src/config/app-config.js';
import { buildTestConfig } from './test-env.js';

export interface TestApp {
  readonly app: NestExpressApplication;
  readonly config: AppConfig;
  /** Every structured log line written so far, joined. */
  readonly logs: () => string;
  readonly close: () => Promise<void>;
}

export interface TestAppOptions {
  readonly env?: Record<string, string>;
  readonly extraModules?: readonly Type[];
}

/** Boots the real AppModule with the production HTTP pipeline (configureApp). */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = buildTestConfig(options.env);
  const chunks: string[] = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config, { logDestination }), ...(options.extraModules ?? [])],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app, config);
  await app.init();

  return {
    app,
    config,
    logs: () => chunks.join(''),
    close: () => app.close(),
  };
}
