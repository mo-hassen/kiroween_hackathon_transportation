import request from 'supertest';
import { ProbeModule } from '../helpers/probe.module.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('request logging', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await testApp.close();
  });

  it('writes structured JSON with the request id, without headers, query strings or bodies', async () => {
    const res = await request(testApp.app.getHttpServer())
      .post('/api/v1/probe/echo?code=oauth-code-SECRET1&state=state-SECRET2')
      .set('Authorization', 'Bearer token-SECRET3')
      .set('Cookie', 'session=cookie-SECRET4')
      .send({ name: 'password-SECRET5', rating: 1 })
      .expect(201);

    const logs = testApp.logs();
    const line = logs
      .split('\n')
      .find((entry) => entry.includes(String(res.headers['x-request-id'])));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as {
      req?: { path?: string; method?: string };
      res?: unknown;
    };
    expect(parsed.req).toMatchObject({ method: 'POST', path: '/api/v1/probe/echo' });
    expect(logs).not.toMatch(/SECRET[1-5]/);
  });

  it('does not log successful health probes', async () => {
    const res = await request(testApp.app.getHttpServer()).get('/api/v1/health/live').expect(200);
    expect(testApp.logs()).not.toContain(String(res.headers['x-request-id']));
  });
});

describe('OpenAPI documentation', () => {
  it('is served when enabled', async () => {
    const testApp = await createTestApp({ env: { API_DOCS_ENABLED: 'true' } });
    try {
      const res = await request(testApp.app.getHttpServer())
        .get('/api/docs/openapi.json')
        .expect(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining(['/api/v1/health/live', '/api/v1/health/ready']),
      );
      await request(testApp.app.getHttpServer()).get('/api/docs').expect(200);
    } finally {
      await testApp.close();
    }
  });

  it('is not served when disabled', async () => {
    const testApp = await createTestApp({ env: { API_DOCS_ENABLED: 'false' } });
    try {
      await request(testApp.app.getHttpServer()).get('/api/docs/openapi.json').expect(404);
      await request(testApp.app.getHttpServer()).get('/api/docs').expect(404);
    } finally {
      await testApp.close();
    }
  });
});
