import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ConfigValidationError, loadConfig } from '../config/app-config.js';
import { OwnerStatusService } from '../modules/owners/owner-status.service.js';

/**
 * Nightly owner job: applies due identity expiries, then moves VERIFIED owners whose
 * identity is no longer verified to EXPIRED or REVERIFICATION_REQUIRED.
 *
 *   node dist/cli/owners-refresh.js
 */
async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
  });
  try {
    const changed = await app.get(OwnerStatusService).sweep();
    process.stdout.write(`Owner refresh: ${changed} profile(s) changed.\n`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write('Owner refresh failed.\n');
    process.exit(1);
  },
);
