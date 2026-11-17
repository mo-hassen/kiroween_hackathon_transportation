import request from 'supertest';
import { ProbeModule } from '../helpers/probe.module.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

// Port 1 is never listening: simulates Redis and object storage outages.
describe('degraded dependencies', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({
      env: {
        REDIS_URL: 'redis://127.0.0.1:1/0',
        STORAGE_ENDPOINT: 'http://127.0.0.1:1',
        RATE_LIMIT_PER_MINUTE: '4',
      },
      extraModules: [ProbeModule],
    });
  });
  afterAll(async () => {
    await testApp.close();
  });

  it('still starts and reports not-ready with component status only', async () => {
    const res = await request(testApp.app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    expect(res.body).toEqual({
      data: { status: 'unavailable', checks: { database: 'up', redis: 'down', storage: 'down' } },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it('keeps liveness green', async () => {
    await request(testApp.app.getHttpServer()).get('/api/v1/health/live').expect(200);
  });

  it('falls back to a stricter in-memory rate limit (half the configured limit)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await request(testApp.app.getHttpServer()).get('/api/v1/probe/ping')).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});
