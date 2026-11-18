import { DiscoveryModule } from '@nestjs/core';
import request from 'supertest';
import { collectRoutes } from '../helpers/routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Every unauthenticated route in the application. Adding @Public() anywhere without
 * updating this list fails the build, so new public surface is always reviewed.
 */
const PUBLIC_ROUTE_ALLOWLIST = [
  // Phase 2: orchestrator probes.
  'GET health/live',
  'GET health/ready',
  // Phase 3: customer authentication (enumeration-safe, rate limited).
  'POST auth/otp',
  'POST auth/register',
  'POST auth/login',
  'POST auth/login/verify',
  'POST auth/refresh',
  'POST auth/logout',
  'POST auth/password/reset/request',
  'POST auth/password/reset/confirm',
  // Phase 3: staff login and activation (password + TOTP).
  'POST auth/staff/login',
  'POST auth/staff/activate',
  'POST auth/staff/activate/confirm',
  // Development/test only: mounted solely with SMS_PROVIDER=dev, which config rejects
  // outside development/test (see sms.module.ts and app-config.spec.ts).
  'GET dev/sms/messages',
  // Phase 4: identity provider browser redirect (single-use state, see the service).
  'GET identity/callback/:provider',
  // Development/test only: the dev identity provider's consent page, mounted solely with
  // IDENTITY_PROVIDER=dev, which config rejects in staging/production.
  'GET dev/identity/authorize',
  'GET dev/identity/authorize/decision',
];

describe('public route allow-list', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ extraModules: [DiscoveryModule] });
  });
  afterAll(async () => {
    await testApp.close();
  });

  it('discovers the application routes', () => {
    expect(collectRoutes(testApp).length).toBeGreaterThan(0);
  });

  it('exposes only allow-listed routes without authentication', () => {
    const publicRoutes = collectRoutes(testApp)
      .filter((route) => route.isPublic)
      .map((route) => route.route)
      .sort();
    expect(publicRoutes).toEqual([...PUBLIC_ROUTE_ALLOWLIST].sort());
  });

  it('rejects every non-public route without credentials', async () => {
    const protectedRoutes = collectRoutes(testApp).filter((route) => !route.isPublic);
    for (const { route } of protectedRoutes) {
      const [method = 'GET', path = ''] = route.split(' ');
      const res = await request(testApp.app.getHttpServer())[method.toLowerCase() as 'get'](
        `/api/v1/${path}`,
      );
      expect({ route, status: res.status }).toEqual({ route, status: 401 });
    }
  });
});
