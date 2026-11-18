import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ConfigValidationError, loadConfig } from '../config/app-config.js';
import { IdentityExpiryService } from '../modules/identity/identity-expiry.service.js';

/**
 * Applies due identity expiries (lapsed sessions, verified identities past valid_until) for
 * all accounts. Run from a scheduler, e.g. daily and every 15 minutes:
 *
 *   node dist/cli/identity-expire.js
 *
 * The same transitions also happen lazily whenever an account reads its identity status.
 */
async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
  });
  try {
    const processed = await app.get(IdentityExpiryService).sweep();
    process.stdout.write(`Identity expiry: ${processed} account(s) updated.\n`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write('Identity expiry sweep failed.\n');
    process.exit(1);
  },
);
