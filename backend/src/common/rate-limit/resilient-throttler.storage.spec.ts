import { ResilientThrottlerStorage, type RedisEval } from './resilient-throttler.storage.js';

const unreachableRedis: RedisEval = {
  eval: () => Promise.reject(new Error('connect ECONNREFUSED')),
};

describe('ResilientThrottlerStorage', () => {
  it('maps the Redis script result to a throttler record', async () => {
    const redis: RedisEval = { eval: () => Promise.resolve([3, 59_500, 0, 0]) };
    const record = await new ResilientThrottlerStorage(redis).increment(
      'k',
      60_000,
      10,
      0,
      'default',
    );
    expect(record).toEqual({
      totalHits: 3,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('passes namespaced keys and the block duration (defaulting to ttl) to Redis', async () => {
    const calls: unknown[][] = [];
    const redis: RedisEval = {
      eval: (...args) => {
        calls.push(args);
        return Promise.resolve([1, 1000, 0, 0]);
      },
    };
    await new ResilientThrottlerStorage(redis, 'test:').increment('abc', 60_000, 5, 0, 'default');
    expect(calls[0]?.slice(1, 6)).toEqual([
      2,
      'test:{default:abc}',
      'test:{default:abc}:block',
      60_000,
      5,
    ]);
    expect(calls[0]?.[6]).toBe(60_000);
  });

  it('rejects malformed script results by falling back', async () => {
    const redis: RedisEval = { eval: () => Promise.resolve('OK') };
    const record = await new ResilientThrottlerStorage(redis).increment(
      'k',
      60_000,
      10,
      0,
      'default',
    );
    expect(record.totalHits).toBe(1);
  });

  it('falls back to an in-memory limiter with half the limit when Redis is down', async () => {
    const storage = new ResilientThrottlerStorage(unreachableRedis);
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await storage.increment('client-1', 60_000, 10, 0, 'default'));
    }
    expect(results.slice(0, 5).every((r) => !r.isBlocked)).toBe(true);
    expect(results[5]?.isBlocked).toBe(true);
  });

  it('never allows a zero limit in fallback mode', async () => {
    const storage = new ResilientThrottlerStorage(unreachableRedis);
    expect((await storage.increment('k', 60_000, 1, 0, 'default')).isBlocked).toBe(false);
    expect((await storage.increment('k', 60_000, 1, 0, 'default')).isBlocked).toBe(true);
  });
});
