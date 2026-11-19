import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ConfigValidationError, loadConfig } from '../config/app-config.js';
import { DriverEligibilityService } from '../modules/drivers/driver-eligibility.service.js';

/**
 * Nightly driver job (02 §3.5, 08 §7 "02:00 Addis time"): expires licences past their date
 * and recomputes every driver's cached eligibility.
 *
 *   node dist/cli/drivers-refresh.js
 */
async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
  });
  try {
    const processed = await app.get(DriverEligibilityService).sweep();
    process.stdout.write(`Driver refresh: ${processed} profile(s) checked.\n`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write('Driver refresh failed.\n');
    process.exit(1);
  },
);
