import { createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

/** Implemented SMS adapters. `dev` stores messages in memory; `disabled` fails closed. */
export const SMS_PROVIDERS = ['dev', 'disabled'] as const;
export type SmsProviderId = (typeof SMS_PROVIDERS)[number];

/**
 * Development/test defaults for server secrets. They are public (committed), so the
 * schema rejects them in staging and production.
 */
export const DEV_ONLY_HASHING_PEPPER = 'a2lyb3dlZW4tbW9iaWxpdHktZGV2LW9ubHktaGFzaGluZy1wZXBwZXI=';
export const DEV_ONLY_FIELD_ENCRYPTION_KEYS = 'dev-1:ZGV2LW9ubHktZmllbGQtZW5jcnlwdGlvbi1rZXktMzI=';
export const DEV_ONLY_FIELD_ENCRYPTION_ACTIVE_KEY_ID = 'dev-1';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const urlString = z.string().refine((value) => URL.canParse(value), { message: 'must be a URL' });

const base64String = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'must be base64' });

/** `kid:base64key[,kid:base64key]`; every key must be 32 bytes (AES-256). */
export function parseEncryptionKeys(value: string): Map<string, Buffer> | string {
  const keys = new Map<string, Buffer>();
  for (const entry of value.split(',').map((item) => item.trim())) {
    const [kid, material, extra] = entry.split(':');
    if (kid === undefined || material === undefined || extra !== undefined) {
      return 'entries must look like kid:base64key';
    }
    if (!/^[a-z0-9-]{1,32}$/.test(kid)) return `key id "${kid}" must match [a-z0-9-]{1,32}`;
    const key = Buffer.from(material, 'base64');
    if (key.length !== 32) return `key "${kid}" must decode to 32 bytes`;
    if (keys.has(kid)) return `key id "${kid}" is duplicated`;
    keys.set(kid, key);
  }
  return keys;
}

function isEd25519PrivateKeyPem(base64Pem: string): boolean {
  try {
    const key = createPrivateKey(Buffer.from(base64Pem, 'base64').toString('utf8'));
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function isIpOrCidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (address === undefined || extra !== undefined) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

/**
 * Raw environment contract. Every variable the API reads is declared here; the process
 * refuses to start when validation fails (see loadConfig).
 */
export const envSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVIRONMENTS),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: urlString,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_URL: urlString,

    STORAGE_ENDPOINT: urlString.optional(),
    STORAGE_REGION: z.string().min(1),
    STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    STORAGE_FORCE_PATH_STYLE: booleanString.default(false),
    STORAGE_ACCESS_KEY_ID: z.string().min(1),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1),

    CORS_ALLOWED_ORIGINS: commaList.default([]),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    API_DOCS_ENABLED: booleanString.optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),

    // Authentication (docs/architecture/07-security-architecture.md §1).
    // Base64-encoded PKCS#8 PEM of an Ed25519 key. Optional in development/test only:
    // an ephemeral key is generated at startup.
    AUTH_JWT_PRIVATE_KEY: base64String.optional(),
    AUTH_JWT_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    // HMAC pepper for OTP codes, tickets, idempotency hashes and rate-limit keys.
    HASHING_PEPPER: base64String.optional(),
    FIELD_ENCRYPTION_KEYS: z.string().min(1).optional(),
    FIELD_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1).optional(),
    SMS_PROVIDER: z.enum(SMS_PROVIDERS).optional(),
    STAFF_IP_ALLOWLIST: commaList.default([]),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };

    for (const origin of env.CORS_ALLOWED_ORIGINS) {
      if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
        issue('CORS_ALLOWED_ORIGINS', `"${origin}" is not a bare origin (scheme://host[:port])`);
      }
    }
    for (const entry of env.STAFF_IP_ALLOWLIST) {
      if (!isIpOrCidr(entry))
        issue('STAFF_IP_ALLOWLIST', `"${entry}" is not an IP address or CIDR`);
    }
    if (
      env.AUTH_JWT_PRIVATE_KEY !== undefined &&
      !isEd25519PrivateKeyPem(env.AUTH_JWT_PRIVATE_KEY)
    ) {
      issue('AUTH_JWT_PRIVATE_KEY', 'must be a base64-encoded PKCS#8 PEM Ed25519 private key');
    }
    if (env.HASHING_PEPPER !== undefined && Buffer.from(env.HASHING_PEPPER, 'base64').length < 32) {
      issue('HASHING_PEPPER', 'must decode to at least 32 bytes');
    }
    if (
      (env.FIELD_ENCRYPTION_KEYS === undefined) !==
      (env.FIELD_ENCRYPTION_ACTIVE_KEY_ID === undefined)
    ) {
      issue(
        'FIELD_ENCRYPTION_KEYS',
        'FIELD_ENCRYPTION_KEYS and FIELD_ENCRYPTION_ACTIVE_KEY_ID go together',
      );
    }
    if (env.FIELD_ENCRYPTION_KEYS !== undefined) {
      const keys = parseEncryptionKeys(env.FIELD_ENCRYPTION_KEYS);
      if (typeof keys === 'string') issue('FIELD_ENCRYPTION_KEYS', keys);
      else if (
        env.FIELD_ENCRYPTION_ACTIVE_KEY_ID !== undefined &&
        !keys.has(env.FIELD_ENCRYPTION_ACTIVE_KEY_ID)
      ) {
        issue('FIELD_ENCRYPTION_ACTIVE_KEY_ID', 'must name one of FIELD_ENCRYPTION_KEYS');
      }
    }

    if (env.APP_ENV !== 'staging' && env.APP_ENV !== 'production') {
      return;
    }
    // Deployed environments: transport security is mandatory.
    const database = new URL(env.DATABASE_URL);
    if (
      !['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode') ?? '')
    ) {
      issue('DATABASE_URL', 'must set sslmode=require|verify-ca|verify-full outside development');
    }
    if (new URL(env.REDIS_URL).protocol !== 'rediss:') {
      issue('REDIS_URL', 'must use rediss:// (TLS) outside development');
    }
    if (env.STORAGE_ENDPOINT && new URL(env.STORAGE_ENDPOINT).protocol !== 'https:') {
      issue('STORAGE_ENDPOINT', 'must use https outside development');
    }
    for (const origin of env.CORS_ALLOWED_ORIGINS) {
      if (URL.canParse(origin) && new URL(origin).protocol !== 'https:') {
        issue('CORS_ALLOWED_ORIGINS', 'origins must use https outside development');
      }
    }
    if (
      /dev[-_]/i.test(env.STORAGE_SECRET_ACCESS_KEY) ||
      /dev_only/i.test(env.DATABASE_URL + env.REDIS_URL)
    ) {
      issue('APP_ENV', 'development credentials are not allowed outside development');
    }
    // Deployed environments: explicit, non-development secrets and real adapters only.
    if (env.AUTH_JWT_PRIVATE_KEY === undefined)
      issue('AUTH_JWT_PRIVATE_KEY', 'is required outside development');
    if (env.AUTH_JWT_KEY_ID === undefined)
      issue('AUTH_JWT_KEY_ID', 'is required outside development');
    if (env.HASHING_PEPPER === undefined || env.HASHING_PEPPER === DEV_ONLY_HASHING_PEPPER) {
      issue('HASHING_PEPPER', 'a non-development value is required outside development');
    }
    if (
      env.FIELD_ENCRYPTION_KEYS === undefined ||
      env.FIELD_ENCRYPTION_KEYS.includes(DEV_ONLY_FIELD_ENCRYPTION_KEYS.split(':')[1] ?? '')
    ) {
      issue('FIELD_ENCRYPTION_KEYS', 'non-development keys are required outside development');
    }
    if (env.FIELD_ENCRYPTION_ACTIVE_KEY_ID?.startsWith('dev') === true) {
      issue(
        'FIELD_ENCRYPTION_ACTIVE_KEY_ID',
        'development key ids are not allowed outside development',
      );
    }
    if (env.SMS_PROVIDER === 'dev') {
      issue(
        'SMS_PROVIDER',
        'the dev SMS adapter is development/test only; no production SMS provider is integrated yet',
      );
    }
  });

export type RawEnv = z.input<typeof envSchema>;
export type ParsedEnv = z.output<typeof envSchema>;
