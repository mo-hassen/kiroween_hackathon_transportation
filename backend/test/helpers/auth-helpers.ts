import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { FieldEncryption } from '../../src/common/crypto/field-encryption.js';
import type { StaffRole } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { PasswordService } from '../../src/modules/auth/password/password.service.js';
import { mfaSecretAad } from '../../src/modules/auth/staff/staff-auth.service.js';
import { generateTotpSecret, hotp, totpStep } from '../../src/modules/auth/staff/totp.js';
import { testRedisUrl } from './test-env.js';

export const STRONG_PASSWORD = 'Bole-Road-Taxi-2026';

export interface Device {
  installationId: string;
  platform: 'ANDROID' | 'IOS' | 'WEB';
  appVersion: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface Customer {
  userId: string;
  phone: string;
  password: string;
  device: Device;
  tokens: Tokens;
}

export interface Staff {
  userId: string;
  phone: string;
  password: string;
  secret: Buffer;
}

export function uniquePhone(): string {
  return `+2519${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')}`;
}

export function newDevice(platform: Device['platform'] = 'ANDROID'): Device {
  return { installationId: randomUUID(), platform, appVersion: '0.2.0' };
}

export function http(app: NestExpressApplication): ReturnType<typeof request> {
  return request(app.getHttpServer());
}

/** Clears all rate-limit counters in the dedicated Redis test database. */
export async function flushRateLimits(): Promise<void> {
  const redis = new Redis(testRedisUrl());
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

/** Newest SMS for a number from the dev inbox (development/test adapter only). */
export async function latestSms(
  app: NestExpressApplication,
  phone: string,
): Promise<{ template: string; text: string } | undefined> {
  const res = await http(app).get('/api/v1/dev/sms/messages').query({ phone }).expect(200);
  return (res.body.data as { template: string; text: string }[])[0];
}

export async function latestCode(app: NestExpressApplication, phone: string): Promise<string> {
  const sms = await latestSms(app, phone);
  const code = /\b(\d{6})\b/.exec(sms?.text ?? '')?.[1];
  if (code === undefined) throw new Error(`No code in SMS for ${phone}`);
  return code;
}

export async function requestRegistrationCode(
  app: NestExpressApplication,
  phone: string,
): Promise<string> {
  await http(app).post('/api/v1/auth/otp').send({ phone }).expect(202);
  return latestCode(app, phone);
}

/** Full journey J1 through the public API: code, register, login. */
export async function registerCustomer(
  app: NestExpressApplication,
  options: { phone?: string; password?: string; device?: Device; displayName?: string } = {},
): Promise<Customer> {
  const phone = options.phone ?? uniquePhone();
  const password = options.password ?? STRONG_PASSWORD;
  const device = options.device ?? newDevice();
  const otp = await requestRegistrationCode(app, phone);
  const registered = await http(app)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', randomUUID())
    .send({ phone, otp, password, displayName: options.displayName ?? 'Test Customer', device })
    .expect(201);
  const tokens = await login(app, phone, password, device);
  return { userId: registered.body.data.userId as string, phone, password, device, tokens };
}

export async function login(
  app: NestExpressApplication,
  phone: string,
  password: string,
  device: Device,
): Promise<Tokens> {
  const res = await http(app)
    .post('/api/v1/auth/login')
    .send({ phone, password, device })
    .expect(200);
  if (res.body.data.result !== 'AUTHENTICATED')
    throw new Error(`Expected AUTHENTICATED, got ${String(res.body.data.result)}`);
  return pickTokens(res.body.data);
}

export function pickTokens(data: Record<string, unknown>): Tokens {
  return {
    accessToken: data['accessToken'] as string,
    refreshToken: data['refreshToken'] as string,
    sessionId: data['sessionId'] as string,
  };
}

export function totpCode(secret: Buffer, offsetSteps = 0): string {
  return hotp(secret, totpStep(Date.now()) + offsetSteps);
}

/** Creates an ACTIVE staff account with a known password and TOTP secret, directly in the DB. */
export async function seedStaff(
  app: NestExpressApplication,
  roles: StaffRole[],
  grantedById: string | null = null,
): Promise<Staff> {
  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);
  const encryption = app.get(FieldEncryption);
  const phone = uniquePhone();
  const password = `Staff-${randomBytes(6).toString('hex')}-Pass`;
  const secret = generateTotpSecret();
  const userId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      phoneE164: phone,
      passwordHash: await passwords.hash(password),
      accountType: 'STAFF',
      status: 'ACTIVE',
      displayName: `Staff ${roles.join('+') || 'none'}`,
      mfaSecretEnc: new Uint8Array(encryption.encrypt(secret, mfaSecretAad(userId))),
      mfaEnrolledAt: new Date(),
    },
  });
  for (const role of roles) {
    await prisma.staffRoleAssignment.create({ data: { userId, role, grantedById } });
  }
  return { userId, phone, password, secret };
}

export async function staffLogin(
  app: NestExpressApplication,
  staff: Staff,
  offsetSteps = 0,
): Promise<Tokens> {
  const res = await http(app)
    .post('/api/v1/auth/staff/login')
    .send({
      phone: staff.phone,
      password: staff.password,
      totpCode: totpCode(staff.secret, offsetSteps),
      device: newDevice('WEB'),
    })
    .expect(200);
  return pickTokens(res.body.data);
}

export function bearer(tokens: Tokens): { Authorization: string } {
  return { Authorization: `Bearer ${tokens.accessToken}` };
}
