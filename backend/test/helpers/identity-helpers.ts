import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'supertest';
import { FieldEncryption } from '../../src/common/crypto/field-encryption.js';
import { randomToken } from '../../src/common/crypto/random.js';
import { sha256Hex } from '../../src/common/crypto/secret-hasher.js';
import { uuidv7 } from '../../src/common/crypto/uuid.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { secretsAad } from '../../src/modules/identity/identity-policy.js';
import type { DevOutcome } from '../../src/providers/identity/dev-identity.provider.js';
import { bearer, http, type Tokens } from './auth-helpers.js';

export const APP_RETURN = 'kiroweenmobility://app/identity/return';

export function uniqueSubject(): string {
  return `dev-test-${randomBytes(8).toString('hex')}`;
}

/** Path and query of an absolute URL (supertest talks to the in-process server). */
export function localPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export async function startVerification(
  app: NestExpressApplication,
  tokens: Tokens,
  options: { key?: string; locale?: 'en' | 'am'; expect?: number } = {},
): Promise<Response> {
  return http(app)
    .post('/api/v1/identity/verifications')
    .set(bearer(tokens))
    .set('Idempotency-Key', options.key ?? randomUUID())
    .send({ consent: true, ...(options.locale === undefined ? {} : { locale: options.locale }) })
    .expect(options.expect ?? 201);
}

export interface DevCallback {
  /** The provider -> API redirect (path + query), replayable. */
  readonly callbackPath: string;
  /** Where the API sent the browser afterwards. */
  readonly returnUrl: string;
  /** The return link's one-time confirmation token, if the provider result was valid. */
  readonly confirmation: string | null;
}

/** Parses `?verification=&confirmation=` from an app return link. */
export function parseReturn(returnUrl: string): {
  verification: string | null;
  confirmation: string | null;
} {
  const params = new URL(returnUrl).searchParams;
  return { verification: params.get('verification'), confirmation: params.get('confirmation') };
}

/** The app, on the return link: POST /identity/verifications/:id/confirm. */
export async function confirmReturn(
  app: NestExpressApplication,
  tokens: Tokens,
  returnUrl: string,
  expectStatus = 200,
): Promise<Response> {
  const { verification, confirmation } = parseReturn(returnUrl);
  return http(app)
    .post(`/api/v1/identity/verifications/${verification ?? ''}/confirm`)
    .set(bearer(tokens))
    .send({ confirmation })
    .expect(expectStatus);
}

/** Plays the browser: consent page, user decision, provider redirect to our callback. */
export async function completeAtDevProvider(
  app: NestExpressApplication,
  authorizationUrl: string,
  options: { outcome?: DevOutcome; subject?: string; name?: string } = {},
): Promise<DevCallback> {
  const callbackPath = await devCallbackPath(app, authorizationUrl, options);
  const callback = await http(app).get(callbackPath).expect(303);
  const returnUrl = callback.headers['location'] as string;
  return { callbackPath, returnUrl, confirmation: parseReturn(returnUrl).confirmation };
}

/** The provider's redirect to our callback, without following it. */
export async function devCallbackPath(
  app: NestExpressApplication,
  authorizationUrl: string,
  options: { outcome?: DevOutcome; subject?: string; name?: string } = {},
): Promise<string> {
  const page = await http(app).get(localPath(authorizationUrl)).expect(200);
  if (!page.text.includes('TEST IDENTITY PROVIDER')) throw new Error('no consent page');
  const csp = String(page.headers['content-security-policy']);
  if (csp.includes('upgrade-insecure-requests') || !csp.includes("default-src 'none'")) {
    throw new Error('dev consent page must not upgrade http links');
  }
  const params = new URL(authorizationUrl).searchParams;
  params.set('outcome', options.outcome ?? 'approve');
  params.set('subject', options.subject ?? uniqueSubject());
  if (options.name !== undefined) params.set('name', options.name);
  const decision = await http(app)
    .get(`/api/v1/dev/identity/authorize/decision?${params.toString()}`)
    .expect(303);
  return localPath(decision.headers['location'] as string);
}

/** Start, complete at the provider and confirm in the same app session: the verification id. */
export async function verifyIdentity(
  app: NestExpressApplication,
  tokens: Tokens,
  subject: string = uniqueSubject(),
  outcome: DevOutcome = 'approve',
): Promise<string> {
  const started = await startVerification(app, tokens);
  const { returnUrl, confirmation } = await completeAtDevProvider(
    app,
    started.body.data.authorizationUrl as string,
    { subject, outcome },
  );
  if (confirmation !== null) await confirmReturn(app, tokens, returnUrl);
  return started.body.data.verification.id as string;
}

export async function overview(app: NestExpressApplication, tokens: Tokens) {
  const res = await http(app)
    .get('/api/v1/identity/verifications/current')
    .set(bearer(tokens))
    .expect(200);
  return res.body.data as {
    identityStatus: string;
    canStart: boolean;
    verifiedName: string | null;
    verifiedAt: string | null;
    validUntil: string | null;
    latest: { id: string; status: string; reason: string | null } | null;
  };
}

/**
 * Inserts an open attempt whose session already lapsed (the TTL cannot be shortened below
 * 5 minutes) and returns its raw state, to drive the callback-after-expiry path.
 */
export async function seedLapsedAttempt(
  app: NestExpressApplication,
  userId: string,
): Promise<{ id: string; state: string }> {
  const prisma = app.get(PrismaService);
  const encryption = app.get(FieldEncryption);
  const id = uuidv7();
  const state = randomToken();
  const secrets = { state, nonce: randomToken(), codeVerifier: randomToken(48) };
  await prisma.$transaction(async (tx) => {
    await tx.identityVerification.create({
      data: {
        id,
        userId,
        provider: 'DEV',
        previousIdentityStatus: 'UNVERIFIED',
        consentedAt: new Date(Date.now() - 20 * 60_000),
        stateHash: sha256Hex(state),
        requestSecretsEnc: new Uint8Array(
          encryption.encrypt(Buffer.from(JSON.stringify(secrets)), secretsAad(id)),
        ),
        createdAt: new Date(Date.now() - 20 * 60_000),
        sessionExpiresAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    await tx.user.update({ where: { id: userId }, data: { identityStatus: 'PENDING' } });
  });
  return { id, state };
}
