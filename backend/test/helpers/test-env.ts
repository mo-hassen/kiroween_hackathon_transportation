import { type AppConfig, loadConfig } from '../../src/config/app-config.js';

/** Redis logical database reserved for tests, so local development counters are untouched. */
export const TEST_REDIS_DB = 15;

/** The suite wipes this database, so refuse anything not clearly named as a test database. */
export function requireTestDatabaseUrl(): string {
  const value = process.env['TEST_DATABASE_URL'];
  if (value === undefined || value === '') {
    throw new Error('TEST_DATABASE_URL is not set (see backend/.env.example)');
  }
  const name = new URL(value).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must end with "_test"`);
  }
  return value;
}

export function testRedisUrl(): string {
  const url = new URL(process.env['REDIS_URL'] ?? '');
  url.pathname = `/${TEST_REDIS_DB}`;
  return url.toString();
}

export function buildTestConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: requireTestDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    CORS_ALLOWED_ORIGINS: 'http://localhost:8080',
    API_DOCS_ENABLED: 'true',
    TRUST_PROXY_HOPS: '0',
    ...overrides,
  });
}
