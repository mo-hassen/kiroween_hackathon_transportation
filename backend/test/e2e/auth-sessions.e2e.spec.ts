import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { AccessTokenService } from '../../src/common/auth/access-token.service.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import {
  bearer,
  flushRateLimits,
  http,
  latestCode,
  login,
  newDevice,
  pickTokens,
  registerCustomer,
  type Tokens,
} from '../helpers/auth-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('sessions, refresh rotation and reuse detection', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  const app = () => testApp.app;
  const refresh = (refreshToken: string) =>
    http(app()).post('/api/v1/auth/refresh').send({ refreshToken });

  beforeAll(async () => {
    testApp = await createTestApp();
    prisma = testApp.app.get(PrismaService);
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  describe('refresh rotation', () => {
    it('rotates the refresh token on every use and keeps the session', async () => {
      const customer = await registerCustomer(app());
      const first = await refresh(customer.tokens.refreshToken).expect(200);
      expect(first.body.data.refreshToken).not.toBe(customer.tokens.refreshToken);
      expect(first.body.data.sessionId).toBe(customer.tokens.sessionId);
      const second = await refresh(first.body.data.refreshToken).expect(200);
      await http(app())
        .get('/api/v1/me')
        .set(bearer(pickTokens(second.body.data)))
        .expect(200);
      const session = await prisma.session.findUniqueOrThrow({
        where: { id: customer.tokens.sessionId },
      });
      // Only digests are stored.
      expect(session.currentTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(session)).not.toContain(second.body.data.refreshToken);
    });

    it('does not extend the absolute session lifetime', async () => {
      const customer = await registerCustomer(app());
      const res = await refresh(customer.tokens.refreshToken).expect(200);
      const session = await prisma.session.findUniqueOrThrow({
        where: { id: customer.tokens.sessionId },
      });
      expect(new Date(res.body.data.refreshTokenExpiresAt).getTime()).toBe(
        session.expiresAt.getTime(),
      );
      // expires_at is computed by the API, created_at by the database clock.
      expect(
        Math.abs(
          session.expiresAt.getTime() - session.createdAt.getTime() - 30 * 24 * 60 * 60 * 1000,
        ),
      ).toBeLessThan(5_000);
    });

    it('accepts the previous token once more within the grace window (lost response on a bad network)', async () => {
      const customer = await registerCustomer(app());
      const lost = await refresh(customer.tokens.refreshToken).expect(200); // client never received this
      const retried = await refresh(customer.tokens.refreshToken).expect(200);
      // The token from the lost response is now retired: using it is theft.
      await http(app())
        .get('/api/v1/me')
        .set(bearer(pickTokens(retried.body.data)))
        .expect(200);
      await refresh(lost.body.data.refreshToken).expect(401);
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: customer.tokens.sessionId } }))
          .revokeReason,
      ).toBe('REFRESH_TOKEN_REUSE');
    });

    it('detects reuse of the previous token after the grace window: revokes the session and notifies', async () => {
      const customer = await registerCustomer(app());
      const rotated = await refresh(customer.tokens.refreshToken).expect(200);
      await prisma.session.update({
        where: { id: customer.tokens.sessionId },
        data: { rotatedAt: new Date(Date.now() - 10 * 60_000) },
      });

      await refresh(customer.tokens.refreshToken).expect(401); // attacker replays the stolen token
      await refresh(rotated.body.data.refreshToken).expect(401); // the legitimate token is dead too
      await http(app())
        .get('/api/v1/me')
        .set(bearer(pickTokens(rotated.body.data)))
        .expect(401);

      const session = await prisma.session.findUniqueOrThrow({
        where: { id: customer.tokens.sessionId },
        include: { device: true },
      });
      expect(session.revokeReason).toBe('REFRESH_TOKEN_REUSE');
      expect(session.device?.trustedAt).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { action: 'auth.refresh_token_reused', targetId: session.id },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: 'auth.session_compromised', aggregateId: customer.userId },
        }),
      ).toBe(1);
    });

    it('detects reuse of an older (retired) token at any time', async () => {
      const customer = await registerCustomer(app());
      const t1 = await refresh(customer.tokens.refreshToken).expect(200);
      await refresh(t1.body.data.refreshToken).expect(200);
      await refresh(customer.tokens.refreshToken).expect(401); // two generations old
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: customer.tokens.sessionId } }))
          .revokedAt,
      ).not.toBeNull();
    });

    it('rejects unknown, malformed and expired refresh tokens', async () => {
      const customer = await registerCustomer(app());
      await refresh('rt_' + 'A'.repeat(43)).expect(401);
      await refresh('not-a-token').expect(401);
      await prisma.session.update({
        where: { id: customer.tokens.sessionId },
        data: {
          createdAt: new Date(Date.now() - 31 * 86_400_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const res = await refresh(customer.tokens.refreshToken).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('serializes concurrent refreshes of the same token (no double rotation)', async () => {
      const customer = await registerCustomer(app());
      const results = await Promise.all([
        refresh(customer.tokens.refreshToken),
        refresh(customer.tokens.refreshToken),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
      // The second one went through the grace path and replaced the first token.
      const live = results.map((r) => r.body.data.refreshToken as string);
      const statuses = [];
      for (const token of live) statuses.push((await refresh(token)).status);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    });
  });

  describe('access tokens', () => {
    it('rejects tampered, foreign-key, expired and unsigned tokens', async () => {
      const customer = await registerCustomer(app());
      const [header, payload, signature] = customer.tokens.accessToken.split('.');
      const forged = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
        string,
        unknown
      >;
      forged['sub'] = randomUUID();
      const tampered = `${header}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
      const foreignKey = await new SignJWT({ sid: customer.tokens.sessionId, typ: 'customer' })
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).kid,
        })
        .setSubject(customer.userId)
        .setIssuer('kiroween-mobility')
        .setAudience('mobility-api')
        .setIssuedAt()
        .setJti(randomUUID())
        .setExpirationTime('10m')
        .sign(generateKeyPairSync('ed25519').privateKey);
      const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;

      for (const token of [tampered, foreignKey, unsigned, 'garbage']) {
        const res = await http(app())
          .get('/api/v1/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
      }
    });

    it('rejects an expired access token', async () => {
      const customer = await registerCustomer(app());
      const tokens = app().get(AccessTokenService);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() - 20 * 60_000);
        const old = await tokens.issue({
          userId: customer.userId,
          sessionId: customer.tokens.sessionId,
          accountType: 'CUSTOMER',
        });
        vi.useRealTimers();
        await http(app()).get('/api/v1/me').set('Authorization', `Bearer ${old.token}`).expect(401);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a customer token whose claims were re-labelled as staff', async () => {
      const customer = await registerCustomer(app());
      const tokens = app().get(AccessTokenService);
      const asStaff = await tokens.issue({
        userId: customer.userId,
        sessionId: customer.tokens.sessionId,
        accountType: 'STAFF',
      });
      await http(app())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${asStaff.token}`)
        .expect(401);
    });
  });

  describe('logout and session management', () => {
    it('logout ends the session immediately for both tokens', async () => {
      const customer = await registerCustomer(app());
      await http(app())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: customer.tokens.refreshToken })
        .expect(204);
      await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(401);
      await refresh(customer.tokens.refreshToken).expect(401);
      expect(
        await prisma.auditLog.count({
          where: { action: 'auth.logout', targetId: customer.tokens.sessionId },
        }),
      ).toBe(1);
    });

    it('logout answers 204 for unknown tokens (no oracle) and is idempotent', async () => {
      await http(app())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'rt_unknown' })
        .expect(204);
      const customer = await registerCustomer(app());
      await http(app())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: customer.tokens.refreshToken })
        .expect(204);
      await http(app())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: customer.tokens.refreshToken })
        .expect(204);
    });

    it('lists only the caller’s active sessions and marks the current one', async () => {
      const customer = await registerCustomer(app());
      const other = await registerCustomer(app());
      const second = await login(app(), customer.phone, customer.password, customer.device);
      await http(app())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: second.refreshToken })
        .expect(204);
      const third = await login(app(), customer.phone, customer.password, customer.device);

      const res = await http(app()).get('/api/v1/me/sessions').set(bearer(third)).expect(200);
      const ids = (res.body.data as { id: string; current: boolean }[]).map((s) => s.id);
      expect(ids.sort()).toEqual([customer.tokens.sessionId, third.sessionId].sort());
      expect(ids).not.toContain(other.tokens.sessionId);
      const sessions = res.body.data as { id: string; current: boolean }[];
      expect(sessions.find((s) => s.id === third.sessionId)?.current).toBe(true);
      expect(res.body.data[0].device).toMatchObject({ platform: 'ANDROID', trusted: true });
    });

    it('revoking another device ends that session and requires an SMS code there next time', async () => {
      const customer = await registerCustomer(app());
      const tablet = newDevice('IOS');
      const start = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: tablet });
      const tabletTokens: Tokens = pickTokens(
        (
          await http(app())
            .post('/api/v1/auth/login/verify')
            .send({
              loginTicket: start.body.data.loginTicket,
              otp: await latestCode(app(), customer.phone),
              device: tablet,
            })
            .expect(200)
        ).body.data,
      );

      await http(app())
        .delete(`/api/v1/me/sessions/${tabletTokens.sessionId}`)
        .set(bearer(customer.tokens))
        .expect(204);
      await http(app()).get('/api/v1/me').set(bearer(tabletTokens)).expect(401);
      await flushRateLimits();
      const again = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: tablet })
        .expect(200);
      expect(again.body.data.result).toBe('OTP_REQUIRED');
    });

    it('returns 404 for another user’s session (IDOR) and for unknown ids', async () => {
      const alice = await registerCustomer(app());
      const bob = await registerCustomer(app());
      const res = await http(app())
        .delete(`/api/v1/me/sessions/${bob.tokens.sessionId}`)
        .set(bearer(alice.tokens))
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      await http(app()).get('/api/v1/me').set(bearer(bob.tokens)).expect(200);
      await http(app())
        .delete(`/api/v1/me/sessions/${randomUUID()}`)
        .set(bearer(alice.tokens))
        .expect(404);
      const bad = await http(app())
        .delete('/api/v1/me/sessions/not-a-uuid')
        .set(bearer(alice.tokens))
        .expect(400);
      expect(bad.body.errors).toEqual([{ field: 'id', code: 'IS_UUID' }]);
    });
  });

  describe('profile', () => {
    it('updates the own profile with optimistic concurrency (If-Match)', async () => {
      const customer = await registerCustomer(app());
      const me = await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(200);
      const version = me.body.data.version as number;
      expect(me.headers.etag).toBe(String(version));

      const updated = await http(app())
        .patch('/api/v1/me')
        .set(bearer(customer.tokens))
        .set('If-Match', String(version))
        .send({ displayName: 'Almaz Tesfaye', preferredLocale: 'am' })
        .expect(200);
      expect(updated.body.data).toMatchObject({
        displayName: 'Almaz Tesfaye',
        preferredLocale: 'am',
        version: version + 1,
      });

      const stale = await http(app())
        .patch('/api/v1/me')
        .set(bearer(customer.tokens))
        .set('If-Match', String(version))
        .send({ displayName: 'X' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      const missing = await http(app())
        .patch('/api/v1/me')
        .set(bearer(customer.tokens))
        .send({ displayName: 'X' });
      expect(missing.status).toBe(428);
      expect(missing.body.code).toBe('PRECONDITION_REQUIRED');
    });

    it('rejects server-controlled fields (mass assignment)', async () => {
      const customer = await registerCustomer(app());
      const res = await http(app())
        .patch('/api/v1/me')
        .set(bearer(customer.tokens))
        .set('If-Match', '0')
        .send({
          status: 'ACTIVE',
          accountType: 'STAFF',
          identityStatus: 'VERIFIED',
          roles: ['SUPER_ADMIN'],
        })
        .expect(400);
      expect((res.body.errors as { code: string }[]).every((e) => e.code === 'UNKNOWN_FIELD')).toBe(
        true,
      );
      const me = await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(200);
      expect(me.body.data).toMatchObject({
        accountType: 'CUSTOMER',
        identityStatus: 'UNVERIFIED',
        roles: [],
      });
    });
  });

  describe('password change and reset', () => {
    it('changes the password with the current one and ends other sessions', async () => {
      const customer = await registerCustomer(app());
      const other = await login(app(), customer.phone, customer.password, customer.device);
      const wrong = await http(app())
        .post('/api/v1/me/password')
        .set(bearer(customer.tokens))
        .send({ currentPassword: 'not-it', newPassword: 'Merkato-Market-2030' })
        .expect(400);
      expect(wrong.body.errors).toEqual([{ field: 'currentPassword', code: 'INCORRECT' }]);

      await http(app())
        .post('/api/v1/me/password')
        .set(bearer(customer.tokens))
        .send({ currentPassword: customer.password, newPassword: 'Merkato-Market-2030' })
        .expect(204);
      await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(200);
      await http(app()).get('/api/v1/me').set(bearer(other)).expect(401);
      await flushRateLimits();
      await login(app(), customer.phone, 'Merkato-Market-2030', customer.device);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: 'auth.password_changed', aggregateId: customer.userId },
        }),
      ).toBe(1);
    });

    it('resets the password by SMS code: all sessions end, lockout clears, other devices lose trust', async () => {
      const customer = await registerCustomer(app());
      await prisma.user.update({
        where: { id: customer.userId },
        data: { failedLoginCount: 9, lockedUntil: new Date(Date.now() + 3_600_000) },
      });
      await http(app())
        .post('/api/v1/auth/password/reset/request')
        .send({ phone: customer.phone })
        .expect(202);
      const code = await latestCode(app(), customer.phone);
      const phone = newDevice('IOS');
      await http(app())
        .post('/api/v1/auth/password/reset/confirm')
        .send({
          phone: customer.phone,
          otp: code,
          newPassword: 'Piassa-Cafe-Morning',
          device: phone,
        })
        .expect(204);

      await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(401);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: customer.userId },
        include: { devices: true },
      });
      expect(user).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
      expect(
        user.devices.find((d) => d.installationId === customer.device.installationId)?.trustedAt,
      ).toBeNull();
      await flushRateLimits();
      await login(app(), customer.phone, 'Piassa-Cafe-Morning', phone); // the reset device is trusted
      await http(app())
        .post('/api/v1/auth/password/reset/confirm')
        .send({
          phone: customer.phone,
          otp: code,
          newPassword: 'Another-Good-Pass-1',
          device: phone,
        })
        .expect(400);
    });

    it('answers reset requests identically for unknown numbers and sends them nothing', async () => {
      const customer = await registerCustomer(app());
      const unknown = `+2517${String(Date.now()).slice(-8)}`;
      const a = await http(app())
        .post('/api/v1/auth/password/reset/request')
        .send({ phone: customer.phone })
        .expect(202);
      const b = await http(app())
        .post('/api/v1/auth/password/reset/request')
        .send({ phone: unknown })
        .expect(202);
      expect(a.body).toEqual(b.body);
      const inbox = await http(app())
        .get('/api/v1/dev/sms/messages')
        .query({ phone: unknown })
        .expect(200);
      expect(inbox.body.data).toEqual([]);
      const confirm = await http(app())
        .post('/api/v1/auth/password/reset/confirm')
        .send({
          phone: unknown,
          otp: '123456',
          newPassword: 'Piassa-Cafe-Morning',
          device: newDevice(),
        })
        .expect(400);
      expect(confirm.body.code).toBe('OTP_INVALID');
    });
  });
});
