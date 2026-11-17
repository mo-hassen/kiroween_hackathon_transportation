import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { normalizeEthiopianMobile } from '../common/validation/ethiopian-phone.js';
import { ConfigValidationError, loadConfig } from '../config/app-config.js';
import { bootstrapSuperAdmin } from './bootstrap.js';

/**
 * Creates the FIRST super administrator. Refuses to run once any super-admin role exists:
 * after that, staff are created by super admins through the admin API.
 *
 *   node dist/cli/bootstrap-super-admin.js --phone 0911234567 --name "Full Name"
 *
 * Prints a one-time activation code to the operator's terminal (that is its purpose; it is
 * not logged). The new admin activates at POST /api/v1/auth/staff/activate.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { phone: { type: 'string' }, name: { type: 'string' } },
  });
  const phone = normalizeEthiopianMobile(values.phone ?? '');
  const name = values.name?.trim() ?? '';
  if (phone === null || name.length === 0 || name.length > 100) {
    process.stderr.write(
      'Usage: bootstrap-super-admin --phone <Ethiopian mobile> --name "<full name>"\n',
    );
    return 2;
  }

  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
  });
  try {
    const result = await bootstrapSuperAdmin(app, { phoneE164: phone, displayName: name });
    if (result.kind === 'ALREADY_BOOTSTRAPPED') {
      process.stderr.write(
        'A super administrator already exists. Use the admin API to add staff.\n',
      );
      return 1;
    }
    process.stdout.write(
      [
        `Super administrator created for ${phone}.`,
        `One-time activation code: ${result.activation.code}`,
        `Expires: ${result.activation.expiresAt.toISOString()}`,
        'Activate with POST /api/v1/auth/staff/activate, then enroll the authenticator app.',
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) process.stderr.write(`${error.message}\n`);
    else if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    ) {
      process.stderr.write('That phone number is already registered.\n');
    } else process.stderr.write('Bootstrap failed.\n');
    process.exit(1);
  },
);
