import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Redis } from 'ioredis';
import pg from 'pg';
import { TEST_REDIS_DB, requireTestDatabaseUrl } from '../helpers/test-env.js';

/**
 * Runs once before the integration suite:
 *  1. drops and recreates the test database schema,
 *  2. applies every migration from zero with `prisma migrate deploy`
 *     (this is the "migrations from an empty database" check),
 *  3. clears the dedicated Redis test database.
 */
export default async function globalSetup(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const databaseUrl = requireTestDatabaseUrl();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const redisUrl = new URL(process.env['REDIS_URL'] ?? '');
  redisUrl.pathname = `/${TEST_REDIS_DB}`;
  const redis = new Redis(redisUrl.toString(), { lazyConnect: true });
  await redis.connect();
  await redis.flushdb();
  redis.disconnect();
}
