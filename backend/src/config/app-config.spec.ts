import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { ConfigValidationError, loadConfig } from './app-config.js';
import { DEV_ONLY_FIELD_ENCRYPTION_KEYS, DEV_ONLY_HASHING_PEPPER } from './env.schema.js';

const productionJwtKey = Buffer.from(
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
).toString('base64');

const developmentEnv = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  STORAGE_REGION: 'us-east-1',
  STORAGE_BUCKET: 'platform-documents',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

const productionEnv = {
  ...developmentEnv,
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.internal:5432/db?sslmode=require',
  REDIS_URL: 'rediss://:pw@redis.internal:6380/0',
  STORAGE_ENDPOINT: 'https://s3.example.et',
  CORS_ALLOWED_ORIGINS: 'https://admin.example.et',
  // Phase 3: secrets that are mandatory outside development.
  AUTH_JWT_PRIVATE_KEY: productionJwtKey,
  AUTH_JWT_KEY_ID: 'prod-2026-11',
  HASHING_PEPPER: randomBytes(32).toString('base64'),
  FIELD_ENCRYPTION_KEYS: `prod-1:${randomBytes(32).toString('base64')}`,
  FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'prod-1',
};

function issuesFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return [...error.issues];
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies safe defaults for development', () => {
    const config = loadConfig(developmentEnv);
    expect(config.http.port).toBe(3000);
    expect(config.apiDocsEnabled).toBe(true);
    expect(config.rateLimit.perMinute).toBe(120);
    expect(config.cors.allowedOrigins).toEqual([]);
    expect(config.isDeployed).toBe(false);
  });

  it('accepts a valid production configuration and disables API docs by default', () => {
    const config = loadConfig(productionEnv);
    expect(config.isDeployed).toBe(true);
    expect(config.apiDocsEnabled).toBe(false);
    expect(config.cors.allowedOrigins).toEqual(['https://admin.example.et']);
  });

  it('rejects missing required variables', () => {
    const issues = issuesFor({ APP_ENV: 'development' });
    expect(issues.some((issue) => issue.startsWith('DATABASE_URL'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('REDIS_URL'))).toBe(true);
  });

  it('rejects an unknown APP_ENV', () => {
    expect(issuesFor({ ...developmentEnv, APP_ENV: 'prod' })).not.toHaveLength(0);
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: 'postgresql://u:p@db:5432/db' }],
    ['REDIS_URL', { REDIS_URL: 'redis://redis:6379' }],
    ['STORAGE_ENDPOINT', { STORAGE_ENDPOINT: 'http://s3.internal' }],
    ['CORS_ALLOWED_ORIGINS', { CORS_ALLOWED_ORIGINS: 'http://admin.example.et' }],
  ])('requires TLS for %s in production', (variable, override) => {
    const issues = issuesFor({ ...productionEnv, ...override });
    expect(issues.some((issue) => issue.startsWith(variable))).toBe(true);
  });

  it('rejects development credentials in production', () => {
    const issues = issuesFor({
      ...productionEnv,
      STORAGE_SECRET_ACCESS_KEY: 'dev-secret-key-not-for-production',
    });
    expect(issues.some((issue) => issue.includes('development credentials'))).toBe(true);
  });

  it('rejects CORS entries that are not bare origins', () => {
    const issues = issuesFor({
      ...developmentEnv,
      CORS_ALLOWED_ORIGINS: 'http://localhost:8080/path,*',
    });
    expect(issues.filter((issue) => issue.startsWith('CORS_ALLOWED_ORIGINS'))).toHaveLength(2);
  });

  it('never includes secret values in validation errors', () => {
    const secret = 'super-secret-db-password';
    const issues = issuesFor({
      ...productionEnv,
      DATABASE_URL: `postgresql://u:${secret}@db:5432/db`,
    });
    expect(issues.join('\n')).not.toContain(secret);
  });

  describe('authentication secrets and adapters (Phase 3)', () => {
    it('uses development defaults: ephemeral JWT key, dev pepper, dev encryption key, dev SMS', () => {
      const config = loadConfig(developmentEnv);
      expect(config.auth.jwtPrivateKeyPem).toBeUndefined();
      expect(config.auth.hashingPepper.length).toBeGreaterThanOrEqual(32);
      expect(config.fieldEncryption.activeKeyId).toBe('dev-1');
      expect(config.fieldEncryption.keys.get('dev-1')).toHaveLength(32);
      expect(config.sms.provider).toBe('dev');
    });

    it('fails closed on SMS in deployed environments (no production provider integrated)', () => {
      expect(loadConfig(productionEnv).sms.provider).toBe('disabled');
      const issues = issuesFor({ ...productionEnv, SMS_PROVIDER: 'dev' });
      expect(issues.some((issue) => issue.startsWith('SMS_PROVIDER'))).toBe(true);
    });

    it.each([
      ['AUTH_JWT_PRIVATE_KEY', { AUTH_JWT_PRIVATE_KEY: undefined }],
      ['AUTH_JWT_KEY_ID', { AUTH_JWT_KEY_ID: undefined }],
      ['HASHING_PEPPER', { HASHING_PEPPER: undefined }],
      ['HASHING_PEPPER', { HASHING_PEPPER: DEV_ONLY_HASHING_PEPPER }],
      [
        'FIELD_ENCRYPTION_KEYS',
        {
          FIELD_ENCRYPTION_KEYS: DEV_ONLY_FIELD_ENCRYPTION_KEYS,
          FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'dev-1',
        },
      ],
    ])('requires a non-development %s in production', (variable, override) => {
      const issues = issuesFor({ ...productionEnv, ...override } as Record<string, string>);
      expect(issues.some((issue) => issue.startsWith(variable))).toBe(true);
    });

    it.each([
      ['not base64', 'not base64!'],
      [
        'an RSA key',
        Buffer.from(
          generateKeyPairSync('rsa', { modulusLength: 2048 })
            .privateKey.export({ type: 'pkcs8', format: 'pem' })
            .toString(),
        ).toString('base64'),
      ],
    ])('rejects a JWT signing key that is %s', (_label, key) => {
      const issues = issuesFor({ ...developmentEnv, AUTH_JWT_PRIVATE_KEY: key });
      expect(issues.some((issue) => issue.startsWith('AUTH_JWT_PRIVATE_KEY'))).toBe(true);
    });

    it('validates encryption key format, size and the active key id', () => {
      const short = Buffer.alloc(16).toString('base64');
      expect(
        issuesFor({
          ...developmentEnv,
          FIELD_ENCRYPTION_KEYS: `k1:${short}`,
          FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
        }),
      ).toContain('FIELD_ENCRYPTION_KEYS: key "k1" must decode to 32 bytes');
      const key = randomBytes(32).toString('base64');
      expect(
        issuesFor({
          ...developmentEnv,
          FIELD_ENCRYPTION_KEYS: `k1:${key}`,
          FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'k2',
        }),
      ).toContain('FIELD_ENCRYPTION_ACTIVE_KEY_ID: must name one of FIELD_ENCRYPTION_KEYS');
      expect(issuesFor({ ...developmentEnv, FIELD_ENCRYPTION_KEYS: `k1:${key}` })).not.toHaveLength(
        0,
      );
    });

    it('validates the staff IP allow-list', () => {
      expect(
        loadConfig({ ...developmentEnv, STAFF_IP_ALLOWLIST: '10.0.0.0/8, 192.168.1.10, ::1' }).auth
          .staffIpAllowlist,
      ).toEqual(['10.0.0.0/8', '192.168.1.10', '::1']);
      expect(
        issuesFor({ ...developmentEnv, STAFF_IP_ALLOWLIST: '10.0.0.0/33,example.com' }),
      ).toHaveLength(2);
    });

    it('never includes the pepper or keys in validation errors', () => {
      const pepper = Buffer.from('short-secret-value').toString('base64');
      const issues = issuesFor({ ...developmentEnv, HASHING_PEPPER: pepper });
      expect(issues.join('\n')).not.toContain(pepper);
    });
  });
});
