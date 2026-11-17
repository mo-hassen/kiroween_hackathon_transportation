import { Redis } from 'ioredis';
import request from 'supertest';
import { ProbeModule } from '../helpers/probe.module.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { testRedisUrl } from '../helpers/test-env.js';

describe('rate limiting (Redis sliding window)', () => {
  const LIMIT = 5;
  let first: TestApp;
  let second: TestApp;

  beforeAll(async () => {
    const redis = new Redis(testRedisUrl());
    await redis.flushdb();
    redis.disconnect();
    const env = { RATE_LIMIT_PER_MINUTE: String(LIMIT) };
    // Two app instances share one Redis: limits must hold across instances.
    first = await createTestApp({ env, extraModules: [ProbeModule] });
    second = await createTestApp({ env, extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await first.close();
    await second.close();
  });

  it('enforces the limit across instances and returns 429 problem details with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i += 1) {
      const target = i % 2 === 0 ? first : second;
      const res = await request(target.app.getHttpServer()).get('/api/v1/probe/ping');
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(LIMIT).fill(200));

    const blocked = await request(second.app.getHttpServer()).get('/api/v1/probe/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('exposes remaining quota headers', async () => {
    const res = await request(first.app.getHttpServer())
      .post('/api/v1/probe/echo')
      .send({ name: 'a', rating: 1 });
    expect(res.headers['x-ratelimit-limit']).toBe(String(LIMIT));
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('does not rate limit health probes', async () => {
    for (let i = 0; i < LIMIT + 3; i += 1) {
      await request(first.app.getHttpServer()).get('/api/v1/health/live').expect(200);
    }
  });
});
