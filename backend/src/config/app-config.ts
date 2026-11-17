import {
  DEV_ONLY_FIELD_ENCRYPTION_ACTIVE_KEY_ID,
  DEV_ONLY_FIELD_ENCRYPTION_KEYS,
  DEV_ONLY_HASHING_PEPPER,
  envSchema,
  parseEncryptionKeys,
  type AppEnvironment,
  type SmsProviderId,
} from './env.schema.js';

/** Typed, validated configuration. Constructed once at startup and injected via APP_CONFIG. */
export interface AppConfig {
  readonly env: AppEnvironment;
  readonly isDeployed: boolean;
  readonly http: { readonly host: string; readonly port: number; readonly trustProxyHops: number };
  readonly logLevel: string;
  readonly database: { readonly url: string; readonly poolMax: number };
  readonly redis: { readonly url: string };
  readonly storage: {
    readonly endpoint: string | undefined;
    readonly region: string;
    readonly bucket: string;
    readonly forcePathStyle: boolean;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly cors: { readonly allowedOrigins: readonly string[] };
  readonly apiDocsEnabled: boolean;
  readonly rateLimit: { readonly perMinute: number };
  readonly auth: {
    /** PKCS#8 PEM; `undefined` means "generate an ephemeral key" (development/test only). */
    readonly jwtPrivateKeyPem: string | undefined;
    readonly jwtKeyId: string;
    readonly hashingPepper: Buffer;
    readonly staffIpAllowlist: readonly string[];
  };
  readonly fieldEncryption: {
    readonly activeKeyId: string;
    readonly keys: ReadonlyMap<string, Buffer>;
  };
  readonly sms: { readonly provider: SmsProviderId };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    // Only variable names and rule descriptions are reported, never values.
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = result.data;
  const isDeployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';

  // Development/test fall back to committed dev-only secrets; the schema has already
  // rejected missing or development values for deployed environments.
  const encryptionKeys = parseEncryptionKeys(
    env.FIELD_ENCRYPTION_KEYS ?? DEV_ONLY_FIELD_ENCRYPTION_KEYS,
  );
  if (typeof encryptionKeys === 'string') {
    throw new ConfigValidationError([`FIELD_ENCRYPTION_KEYS: ${encryptionKeys}`]);
  }

  return Object.freeze({
    env: env.APP_ENV,
    isDeployed,
    http: { host: env.HOST, port: env.PORT, trustProxyHops: env.TRUST_PROXY_HOPS },
    logLevel: env.LOG_LEVEL,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    redis: { url: env.REDIS_URL },
    storage: {
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    },
    cors: { allowedOrigins: Object.freeze([...env.CORS_ALLOWED_ORIGINS]) },
    // API docs are off by default in deployed environments.
    apiDocsEnabled: env.API_DOCS_ENABLED ?? !isDeployed,
    rateLimit: { perMinute: env.RATE_LIMIT_PER_MINUTE },
    auth: {
      jwtPrivateKeyPem:
        env.AUTH_JWT_PRIVATE_KEY === undefined
          ? undefined
          : Buffer.from(env.AUTH_JWT_PRIVATE_KEY, 'base64').toString('utf8'),
      jwtKeyId: env.AUTH_JWT_KEY_ID ?? 'ephemeral',
      hashingPepper: Buffer.from(env.HASHING_PEPPER ?? DEV_ONLY_HASHING_PEPPER, 'base64'),
      staffIpAllowlist: Object.freeze([...env.STAFF_IP_ALLOWLIST]),
    },
    fieldEncryption: {
      activeKeyId: env.FIELD_ENCRYPTION_ACTIVE_KEY_ID ?? DEV_ONLY_FIELD_ENCRYPTION_ACTIVE_KEY_ID,
      keys: encryptionKeys,
    },
    // No production SMS provider is integrated: deployed environments fail closed.
    sms: { provider: env.SMS_PROVIDER ?? (isDeployed ? 'disabled' : 'dev') },
  });
}
