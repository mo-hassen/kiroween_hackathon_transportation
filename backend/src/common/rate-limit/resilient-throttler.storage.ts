import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** The subset of the ioredis client this storage needs (eases testing). */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Sliding-window log in a sorted set, evaluated atomically in Redis using the Redis clock
 * so all API instances share one view. Requests rejected while blocked are not recorded.
 * Returns [hits, windowMsRemaining, blocked(0|1), blockMsRemaining].
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
local member = ARGV[4]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  return { redis.call('ZCARD', key), math.max(redis.call('PTTL', key), 0), 1, blockTtl }
end
redis.call('ZREMRANGEBYSCORE', key, 0, now - ttl)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, ttl)
local hits = redis.call('ZCARD', key)
if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockMs)
  return { hits, ttl, 1, blockMs }
end
return { hits, ttl, 0, 0 }
`;

const toSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

function parseScriptResult(raw: unknown): ThrottlerStorageRecord {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((value) => typeof value === 'number')) {
    throw new Error('Unexpected rate-limit script result');
  }
  const [hits, windowMs, blocked, blockMs] = raw as [number, number, number, number];
  return {
    totalHits: hits,
    timeToExpire: toSeconds(windowMs),
    isBlocked: blocked === 1,
    timeToBlockExpire: toSeconds(blockMs),
  };
}

/**
 * Distributed rate-limit storage. When Redis is unreachable, falls back to a per-instance
 * in-memory limiter with half the configured limit: stricter, so an outage does not open
 * the API to abuse, but not fail-closed, so the API stays available
 * (docs/architecture/11-operations-testing-deployment.md, failure scenarios).
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private readonly fallback = new ThrottlerStorageService();
  private lastWarningAt = 0;

  constructor(
    private readonly redis: RedisEval,
    private readonly keyPrefix = 'rl:',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.keyPrefix}{${throttlerName}:${key}}`;
    const member = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const blockMs = blockDuration > 0 ? blockDuration : ttl;
    try {
      const raw = await this.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        2,
        base,
        `${base}:block`,
        ttl,
        limit,
        blockMs,
        member,
      );
      return parseScriptResult(raw);
    } catch (error) {
      this.warnThrottled(error);
      const strictLimit = Math.max(1, Math.floor(limit / 2));
      return this.fallback.increment(key, ttl, strictLimit, blockMs, throttlerName);
    }
  }

  private warnThrottled(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 60_000) return;
    this.lastWarningAt = now;
    this.logger.warn(
      { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
      'Redis rate-limit storage unavailable; using stricter in-memory fallback',
    );
  }
}
