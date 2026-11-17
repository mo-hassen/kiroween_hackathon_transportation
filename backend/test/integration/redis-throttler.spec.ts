import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { ResilientThrottlerStorage } from '../../src/common/rate-limit/resilient-throttler.storage.js';
import { testRedisUrl } from '../helpers/test-env.js';

describe('ResilientThrottlerStorage against real Redis', () => {
  let redis: Redis;
  let storage: ResilientThrottlerStorage;

  beforeAll(() => {
    redis = new Redis(testRedisUrl());
    storage = new ResilientThrottlerStorage(redis, 'test-rl:');
  });
  afterAll(() => {
    redis.disconnect();
  });

  it('counts hits, blocks after the limit and reports the block time', async () => {
    const key = randomUUID();
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await storage.increment(key, 60_000, 3, 30_000, 'default'));
    }
    expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
    expect(results.slice(0, 3).every((r) => !r.isBlocked)).toBe(true);
    expect(results[3]).toMatchObject({ isBlocked: true, timeToBlockExpire: 30 });
  });

  it('does not record requests made while blocked', async () => {
    const key = randomUUID();
    for (let i = 0; i < 6; i += 1) {
      await storage.increment(key, 60_000, 1, 60_000, 'default');
    }
    expect(await redis.zcard(`test-rl:{default:${key}}`)).toBe(2);
  });

  it('slides the window: old hits expire', async () => {
    const key = randomUUID();
    await storage.increment(key, 300, 1, 300, 'default');
    expect((await storage.increment(key, 300, 1, 300, 'default')).isBlocked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = await storage.increment(key, 300, 1, 300, 'default');
    expect(after).toMatchObject({ isBlocked: false, totalHits: 1 });
  });

  it('is atomic under concurrent increments', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.increment(key, 60_000, 10, 60_000, 'default')),
    );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(10);
  });

  it('sets expiry on its keys so Redis memory is reclaimed', async () => {
    const key = randomUUID();
    await storage.increment(key, 60_000, 5, 0, 'default');
    const ttl = await redis.pttl(`test-rl:{default:${key}}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
