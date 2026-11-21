import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ConfigValidationError, loadConfig } from '../config/app-config.js';
import { VehicleStatusService } from '../modules/vehicles/vehicle-status.service.js';

/**
 * Nightly vehicle job: moves APPROVED vehicles whose insurance or inspection ended before
 * today's Addis Ababa date to EXPIRED. No scheduler is deployed yet, so run it from cron (or
 * a platform scheduled job) until Phase 15.
 *
 *   node dist/cli/vehicles-refresh.js
 */
async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
  });
  try {
    const changed = await app.get(VehicleStatusService).sweep();
    process.stdout.write(`Vehicle refresh: ${changed} vehicle(s) changed.\n`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write('Vehicle refresh failed.\n');
    process.exit(1);
  },
);
